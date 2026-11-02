import { Node } from 'web-tree-sitter';
import { GrammarName, TreeSitter } from './treeSitter.js';

export type SymbolKind = 'class' | 'function' | 'method' | 'interface' | 'type' | 'enum';

export interface SymbolFact {
  name: string;
  // `Class.method` for members, otherwise the plain name
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  isDefaultExport: boolean;
  // Declaration up to its body, whitespace collapsed (e.g. `async revoke(id: string): Promise<void>`)
  signature: string;
  decorators: string[];
  // Declared inside another function (a local helper such as `const toRel = ...` in a method), not at module or class level
  nestedInFunction: boolean;
}

export interface ImportBindingFact {
  // Exported name, 'default', or '*' for namespace / CommonJS module objects
  imported: string;
  local: string;
  typeOnly: boolean;
}

export interface ImportFact {
  specifier: string;
  line: number;
  bindings: ImportBindingFact[];
  // `import()` / `require()` / re-exports (`export ... from`)
  kind: 'static' | 'dynamic' | 'require' | 're-export';
}

export interface CallFact {
  // Callee as written: `fn`, `api.delete`, `this.audit`, `new KeyService` (as `KeyService`), `<Button>` (as `Button`)
  callee: string;
  line: number;
  // Qualified name of the innermost named function/method containing the call
  enclosing?: string;
  // Outermost named function containing the call (e.g. the component that declares the `onSubmit` handler)
  outermost?: string;
  form: 'call' | 'new' | 'jsx';
  // First argument when it is a string or template literal, unquoted (`router.get('/articles', ...)` -> `/articles`)
  firstStringArg?: string;
}

export interface ValueReference {
  // Identifier passed as a value (argument, object/array element, JSX expression), e.g. `router.get('/x', handler)`
  name: string;
  line: number;
  enclosing?: string;
}

export interface ClassMemberType {
  className: string;
  // Property name as used in `this.<property>`
  property: string;
  // Declared type as written, e.g. `ArticleService` or `Repository<ArticleEntity>`
  type: string;
  line: number;
}

export interface CodeFacts {
  grammar: GrammarName;
  symbols: SymbolFact[];
  imports: ImportFact[];
  calls: CallFact[];
  valueRefs: ValueReference[];
  // Typed constructor parameter properties and fields (dependency injection: `private readonly svc: Service`)
  memberTypes: ClassMemberType[];
  hasSyntaxErrors: boolean;
}

const MAX_CACHE = 5000;
const cache = new Map<string, { content: string; facts: CodeFacts | null }>();

const JS_FUNCTION_TYPES = new Set(['function_declaration', 'generator_function_declaration', 'method_definition', 'arrow_function', 'function_expression', 'function', 'generator_function']);
const JS_CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const VALUE_POSITION_PARENTS = new Set(['arguments', 'array', 'pair', 'jsx_expression', 'return_statement', 'shorthand_property_identifier']);

/**
 * Syntax-tree facts for a source file, or null when tree-sitter is not initialised or the language is
 * unsupported (callers then use the regex extractors). Results are cached per file until its content changes.
 */
export function extractCodeFacts(filePath: string, content: string): CodeFacts | null {
  const cached = cache.get(filePath);
  if (cached && cached.content === content) return cached.facts;

  const grammar = TreeSitter.grammarFor(filePath);
  const tree = grammar ? TreeSitter.parse(filePath, content) : null;
  let facts: CodeFacts | null = null;
  if (tree && grammar) {
    try {
      facts = grammar === 'python' ? pythonFacts(tree.rootNode) : jsFacts(tree.rootNode, grammar);
    } finally {
      tree.delete();
    }
  }

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(filePath, { content, facts });
  return facts;
}

const line = (n: Node) => n.startPosition.row + 1;

/**
 * Callee as a short, matchable name: `fn`, `api.delete`, `this.audit`. Complex receivers such as chained calls
 * (`program.command('x').option(...)`) are shortened to `(…).option`.
 */
function calleeName(fn: Node): string {
  const text = fn.text.replace(/\s+/g, '');
  if (/^[\w$.]+$/.test(text)) return text;
  if (fn.type === 'member_expression' || fn.type === 'attribute') {
    const property = (fn.childForFieldName('property') ?? fn.childForFieldName('attribute'))?.text;
    if (property) return `(…).${property}`;
  }
  return collapse(fn.text).slice(0, 80);
}
const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, '');
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

// Unquoted value of a string or template-literal argument (`'/api/keys'`, `` `/api/keys/${id}` ``), else undefined
function stringValue(node: Node | null | undefined): string | undefined {
  if (!node || !['string', 'template_string'].includes(node.type)) return undefined;
  return node.text.slice(1, -1);
}

// `: Repository<ArticleEntity>` -> `Repository<ArticleEntity>`
function typeText(annotation: Node | null): string | undefined {
  const text = annotation?.text.replace(/^:\s*/, '').replace(/\s+/g, '');
  return text || undefined;
}

function signatureOf(node: Node): string {
  const body = node.childForFieldName('body');
  const text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text.split('\n')[0];
  return collapse(text.replace(/[{:=]\s*$/, ''));
}

function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// JavaScript / TypeScript / TSX

function jsFacts(root: Node, grammar: GrammarName): CodeFacts {
  const symbols: SymbolFact[] = [];
  const imports: ImportFact[] = [];
  const calls: CallFact[] = [];
  const valueRefs: ValueReference[] = [];
  const memberTypes: ClassMemberType[] = [];

  const exportInfo = (node: Node) => {
    // `export function f`, `export default class C`, `export const f = () => ...`
    let current: Node | null = node.parent;
    for (let hops = 0; current && hops < 3; hops++, current = current.parent) {
      if (current.type === 'export_statement') {
        return { exported: true, isDefault: current.children.some(c => c?.type === 'default') };
      }
      if (!['lexical_declaration', 'variable_declaration', 'variable_declarator'].includes(current.type)) break;
    }
    return { exported: false, isDefault: false };
  };

  const decoratorsOf = (node: Node) => {
    const own = node.namedChildren.filter((c): c is Node => c?.type === 'decorator').map(c => collapse(c.text));
    // Class-member decorators can also be preceding siblings in the class body
    let sibling = node.previousNamedSibling;
    while (sibling && sibling.type === 'decorator') {
      own.unshift(collapse(sibling.text));
      sibling = sibling.previousNamedSibling;
    }
    return own;
  };

  const enclosingClass = (node: Node): string | undefined => {
    for (let p = node.parent; p; p = p.parent) {
      if (JS_CLASS_TYPES.has(p.type)) return p.childForFieldName('name')?.text;
    }
    return undefined;
  };

  // Name of a function-like node, or undefined for anonymous callbacks
  const functionName = (fn: Node): string | undefined => {
    if (fn.type === 'method_definition') {
      const name = fn.childForFieldName('name')?.text;
      const cls = enclosingClass(fn);
      return name ? (cls ? `${cls}.${name}` : name) : undefined;
    }
    const own = fn.childForFieldName('name')?.text;
    if (own) return own;
    const parent = fn.parent;
    if (parent?.type === 'variable_declarator') return parent.childForFieldName('name')?.text;
    if (parent?.type === 'public_field_definition' || parent?.type === 'field_definition') {
      const name = parent.childForFieldName('name')?.text ?? parent.childForFieldName('property')?.text;
      const cls = enclosingClass(parent);
      return name ? (cls ? `${cls}.${name}` : name) : undefined;
    }
    // Object members: `{ onClick: () => ... }` directly, or through a call chain such as a tRPC procedure
    // `create: protectedProcedure.input(schema).mutation(({ ctx }) => ...)`; named `<object variable>.<key>`
    let holder: Node | null = parent ?? null;
    while (holder && ['arguments', 'call_expression', 'member_expression', 'await_expression'].includes(holder.type)) holder = holder.parent;
    if (holder?.type === 'pair') {
      const key = holder.childForFieldName('key')?.text;
      if (!key) return undefined;
      let owner: Node | null = holder.parent;
      for (let hops = 0; owner && hops < 4 && owner.type !== 'variable_declarator'; hops++) owner = owner.parent;
      const objectName = owner?.type === 'variable_declarator' ? owner.childForFieldName('name')?.text : undefined;
      return objectName ? `${objectName}.${key}` : key;
    }
    return undefined;
  };

  // Named functions containing a node, innermost first; anonymous callbacks defer to their named parent
  const namedAncestors = (node: Node): string[] => {
    const names: string[] = [];
    for (let p = node.parent; p; p = p.parent) {
      if (JS_FUNCTION_TYPES.has(p.type)) {
        const name = functionName(p);
        if (name) names.push(name);
      }
    }
    return names;
  };
  const enclosingOf = (node: Node): string | undefined => namedAncestors(node)[0];
  const outermostOf = (node: Node): string | undefined => {
    const names = namedAncestors(node);
    return names[names.length - 1];
  };
  const insideDecorator = (node: Node): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'decorator') return true;
      if (JS_FUNCTION_TYPES.has(p.type) || p.type === 'statement_block') return false;
    }
    return false;
  };
  // Any function (named or not) between this declaration and the module/class level
  const insideFunction = (node: Node): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (JS_FUNCTION_TYPES.has(p.type)) return true;
    }
    return false;
  };

  const addSymbol = (node: Node, name: string | undefined, kind: SymbolKind, qualified?: string) => {
    if (!name) return;
    const { exported, isDefault } = exportInfo(node);
    symbols.push({
      name,
      qualifiedName: qualified ?? name,
      kind,
      startLine: line(node),
      endLine: node.endPosition.row + 1,
      exported,
      isDefaultExport: isDefault,
      signature: signatureOf(node),
      decorators: decoratorsOf(node),
      nestedInFunction: insideFunction(node)
    });
  };

  walk(root, node => {
    switch (node.type) {
      case 'class_declaration':
      case 'abstract_class_declaration':
        addSymbol(node, node.childForFieldName('name')?.text, 'class');
        break;
      case 'interface_declaration':
        addSymbol(node, node.childForFieldName('name')?.text, 'interface');
        break;
      case 'type_alias_declaration':
        addSymbol(node, node.childForFieldName('name')?.text, 'type');
        break;
      case 'enum_declaration':
        addSymbol(node, node.childForFieldName('name')?.text, 'enum');
        break;
      case 'function_declaration':
      case 'generator_function_declaration':
        addSymbol(node, node.childForFieldName('name')?.text, 'function');
        break;
      case 'method_definition': {
        const name = node.childForFieldName('name')?.text;
        const cls = enclosingClass(node);
        addSymbol(node, name, 'method', name && cls ? `${cls}.${name}` : name);
        break;
      }
      case 'variable_declarator': {
        const value = node.childForFieldName('value');
        if (value && ['arrow_function', 'function_expression', 'function'].includes(value.type)) {
          // Report the declaration's line range and export status, with the function's signature
          const declaration = node.parent ?? node;
          const name = node.childForFieldName('name')?.text;
          const { exported, isDefault } = exportInfo(node);
          if (name) {
            symbols.push({
              name, qualifiedName: name, kind: 'function', startLine: line(declaration), endLine: declaration.endPosition.row + 1,
              exported, isDefaultExport: isDefault, signature: collapse(`${name} = ${signatureOf(value)}`), decorators: [],
              nestedInFunction: insideFunction(node)
            });
          }
        }
        break;
      }
      case 'public_field_definition':
      case 'field_definition': {
        const value = node.childForFieldName('value');
        const name = node.childForFieldName('name')?.text ?? node.childForFieldName('property')?.text;
        const cls = enclosingClass(node);
        if (value && ['arrow_function', 'function_expression'].includes(value.type)) {
          addSymbol(node, name, 'method', name && cls ? `${cls}.${name}` : name);
        } else {
          // Typed field: `@Inject() private readonly mailer: Mailer;`
          const type = typeText(node.childForFieldName('type'));
          if (name && cls && type) memberTypes.push({ className: cls, property: name, type, line: line(node) });
        }
        break;
      }
      case 'required_parameter':
      case 'optional_parameter': {
        // Constructor parameter property: `constructor(private readonly articleService: ArticleService)`
        const isProperty = node.children.some(c => c?.type === 'accessibility_modifier' || c?.type === 'readonly' || c?.type === 'override_modifier');
        const method = node.parent?.parent;
        if (!isProperty || method?.type !== 'method_definition' || method.childForFieldName('name')?.text !== 'constructor') break;
        const name = node.childForFieldName('pattern')?.text;
        const type = typeText(node.childForFieldName('type'));
        const cls = enclosingClass(node);
        if (name && cls && type) memberTypes.push({ className: cls, property: name, type, line: line(node) });
        break;
      }
      case 'import_statement':
        imports.push(jsImport(node));
        break;
      case 'export_statement': {
        const source = node.childForFieldName('source');
        if (source) imports.push({ specifier: unquote(source.text), line: line(node), bindings: [], kind: 're-export' });
        break;
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (!fn) break;
        // `@Get(':id')` / `@Param('id')` are recorded as decorators on the symbol, not as calls it makes
        if (insideDecorator(node)) break;
        const firstArg = node.childForFieldName('arguments')?.namedChildren[0];
        if (fn.type === 'import' && firstArg?.type === 'string') {
          imports.push({ specifier: unquote(firstArg.text), line: line(node), bindings: [], kind: 'dynamic' });
        } else if (fn.type === 'identifier' && fn.text === 'require' && firstArg?.type === 'string') {
          imports.push(requireImport(node, unquote(firstArg.text)));
        } else {
          calls.push({ callee: calleeName(fn), line: line(node), enclosing: enclosingOf(node), outermost: outermostOf(node), form: 'call', firstStringArg: stringValue(firstArg) });
        }
        break;
      }
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor');
        if (ctor) calls.push({ callee: calleeName(ctor), line: line(node), enclosing: enclosingOf(node), outermost: outermostOf(node), form: 'new' });
        break;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const name = node.childForFieldName('name')?.text;
        // Lowercase tags are DOM elements, not components
        if (name && /^[A-Z]|\./.test(name)) calls.push({ callee: name, line: line(node), enclosing: enclosingOf(node), outermost: outermostOf(node), form: 'jsx' });
        break;
      }
      case 'identifier': {
        const parent = node.parent;
        if (parent && (VALUE_POSITION_PARENTS.has(parent.type) || (parent.type === 'pair' && parent.childForFieldName('value')?.id === node.id))) {
          valueRefs.push({ name: node.text, line: line(node), enclosing: enclosingOf(node) });
        }
        break;
      }
      case 'shorthand_property_identifier':
        valueRefs.push({ name: node.text, line: line(node), enclosing: enclosingOf(node) });
        break;
    }
  });

  return { grammar, symbols, imports, calls, valueRefs, memberTypes, hasSyntaxErrors: root.hasError };
}

function jsImport(node: Node): ImportFact {
  const specifier = unquote(node.childForFieldName('source')?.text ?? '');
  // `import type { A } from '...'` marks the whole statement type-only
  const statementTypeOnly = node.children.some(c => c?.type === 'type');
  const bindings: ImportBindingFact[] = [];
  const clause = node.namedChildren.find(c => c?.type === 'import_clause');
  clause?.namedChildren.forEach(part => {
    if (!part) return;
    if (part.type === 'identifier') {
      bindings.push({ imported: 'default', local: part.text, typeOnly: statementTypeOnly });
    } else if (part.type === 'namespace_import') {
      const local = part.namedChildren.find(c => c?.type === 'identifier')?.text;
      if (local) bindings.push({ imported: '*', local, typeOnly: statementTypeOnly });
    } else if (part.type === 'named_imports') {
      part.namedChildren.forEach(spec => {
        if (!spec || spec.type !== 'import_specifier') return;
        const imported = spec.childForFieldName('name')?.text;
        const alias = spec.childForFieldName('alias')?.text;
        const specTypeOnly = statementTypeOnly || spec.children.some(c => c?.type === 'type');
        if (imported) bindings.push({ imported, local: alias ?? imported, typeOnly: specTypeOnly });
      });
    }
  });
  return { specifier, line: line(node), bindings, kind: 'static' };
}

function requireImport(call: Node, specifier: string): ImportFact {
  // `const x = require('m')` binds the module object; `const { a, b: c } = require('m')` binds members
  const declarator = call.parent?.type === 'variable_declarator' ? call.parent : null;
  const target = declarator?.childForFieldName('name');
  const bindings: ImportBindingFact[] = [];
  if (target?.type === 'identifier') {
    bindings.push({ imported: '*', local: target.text, typeOnly: false });
  } else if (target?.type === 'object_pattern') {
    target.namedChildren.forEach(prop => {
      if (!prop) return;
      if (prop.type === 'shorthand_property_identifier_pattern') bindings.push({ imported: prop.text, local: prop.text, typeOnly: false });
      if (prop.type === 'pair_pattern') {
        const key = prop.childForFieldName('key')?.text;
        const value = prop.childForFieldName('value')?.text;
        if (key && value) bindings.push({ imported: key, local: value, typeOnly: false });
      }
    });
  }
  return { specifier, line: line(call), bindings, kind: 'require' };
}

// ---------------------------------------------------------------------------------------------------------
// Python

function pythonFacts(root: Node): CodeFacts {
  const symbols: SymbolFact[] = [];
  const imports: ImportFact[] = [];
  const calls: CallFact[] = [];
  const valueRefs: ValueReference[] = [];

  const enclosingClass = (node: Node): string | undefined => {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'class_definition') return p.childForFieldName('name')?.text;
      if (p.type === 'function_definition') return undefined;
    }
    return undefined;
  };
  const qualified = (fn: Node) => {
    const name = fn.childForFieldName('name')?.text ?? '';
    const cls = enclosingClass(fn);
    return cls ? `${cls}.${name}` : name;
  };
  const enclosingOf = (node: Node): string | undefined => {
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'function_definition') return qualified(p);
    }
    return undefined;
  };
  const outermostOf = (node: Node): string | undefined => {
    let outer: string | undefined;
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'function_definition') outer = qualified(p);
    }
    return outer;
  };
  const decoratorsOf = (node: Node) =>
    node.parent?.type === 'decorated_definition'
      ? node.parent.namedChildren.filter((c): c is Node => c?.type === 'decorator').map(c => collapse(c.text))
      : [];

  walk(root, node => {
    switch (node.type) {
      case 'class_definition':
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        const isMethod = node.type === 'function_definition' && Boolean(enclosingClass(node));
        const container = node.parent?.type === 'decorated_definition' ? node.parent : node;
        symbols.push({
          name,
          qualifiedName: node.type === 'function_definition' ? qualified(node) : name,
          kind: node.type === 'class_definition' ? 'class' : isMethod ? 'method' : 'function',
          startLine: line(container),
          endLine: node.endPosition.row + 1,
          // Python has no export keyword; module-level names without a leading underscore are public
          exported: !name.startsWith('_') && (container.parent?.type === 'module'),
          isDefaultExport: false,
          signature: signatureOf(node),
          decorators: decoratorsOf(node),
          nestedInFunction: Boolean(enclosingOf(node))
        });
        break;
      }
      case 'import_statement':
        node.namedChildren.forEach(child => {
          if (!child) return;
          const dotted = child.type === 'aliased_import' ? child.childForFieldName('name')?.text : child.text;
          const alias = child.type === 'aliased_import' ? child.childForFieldName('alias')?.text : undefined;
          if (dotted) imports.push({ specifier: dotted, line: line(node), bindings: [{ imported: '*', local: alias ?? dotted, typeOnly: false }], kind: 'static' });
        });
        break;
      case 'import_from_statement': {
        const moduleName = node.childForFieldName('module_name')?.text;
        if (!moduleName) break;
        const bindings: ImportBindingFact[] = [];
        node.childrenForFieldName('name').forEach(child => {
          if (!child) return;
          if (child.type === 'aliased_import') {
            const name = child.childForFieldName('name')?.text;
            const alias = child.childForFieldName('alias')?.text;
            if (name) bindings.push({ imported: name, local: alias ?? name, typeOnly: false });
          } else {
            bindings.push({ imported: child.text, local: child.text, typeOnly: false });
          }
        });
        imports.push({ specifier: moduleName, line: line(node), bindings, kind: 'static' });
        break;
      }
      case 'call': {
        const fn = node.childForFieldName('function');
        if (fn) calls.push({ callee: calleeName(fn), line: line(node), enclosing: enclosingOf(node), outermost: outermostOf(node), form: 'call', firstStringArg: stringValue(node.childForFieldName('arguments')?.namedChildren[0]) });
        break;
      }
      case 'identifier': {
        const parent = node.parent;
        if (parent && (parent.type === 'argument_list' || parent.type === 'list' || parent.type === 'keyword_argument' && parent.childForFieldName('value')?.id === node.id)) {
          valueRefs.push({ name: node.text, line: line(node), enclosing: enclosingOf(node) });
        }
        break;
      }
    }
  });

  return { grammar: 'python', symbols, imports, calls, valueRefs, memberTypes: [], hasSyntaxErrors: root.hasError };
}
