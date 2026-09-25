import * as fs from 'fs';
import * as path from 'path';
import { ASTExtractor } from '../extractors/astExtractor.js';

export interface RouteEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL';
  routePath: string;
  definedInFile: string;
}

export interface MicroserviceAPIRegistry {
  microserviceName: string;
  exposedRoutes: RouteEndpoint[];
  consumedRoutes: string[];
}

export class RouteRegistryManager {
  public static extractServiceRoutes(repoPath: string): MicroserviceAPIRegistry {
    const facts = ASTExtractor.scanDirectory(repoPath);
    const serviceName = path.basename(repoPath);
    const exposedRoutes: RouteEndpoint[] = [];
    const consumedRoutes: Set<string> = new Set();

    const routeDefRegex = /(app|router|server)\.(get|post|put|delete|patch|all)\s*\(\s*['"]([^'"]+)['"]/ig;
    const fetchRouteRegex = /(?:fetch|axios\.(?:get|post|put|delete)|http:\/\/[a-zA-Z0-9_\-]+)\s*\(\s*['"]([^'"]+)['"]/ig;

    facts.forEach(fact => {
      if (!fs.existsSync(fact.filePath)) return;
      let content = '';
      try {
        content = fs.readFileSync(fact.filePath, 'utf8');
      } catch {
        return;
      }

      // Extract Exposed Routes
      let match;
      while ((match = routeDefRegex.exec(content)) !== null) {
        const method = match[2].toUpperCase() as RouteEndpoint['method'];
        const routePath = match[3];
        exposedRoutes.push({
          method,
          routePath,
          definedInFile: path.relative(repoPath, fact.filePath)
        });
      }

      // Extract Consumed Routes
      let fetchMatch;
      while ((fetchMatch = fetchRouteRegex.exec(content)) !== null) {
        consumedRoutes.add(fetchMatch[1]);
      }
    });

    const registry: MicroserviceAPIRegistry = {
      microserviceName: serviceName,
      exposedRoutes,
      consumedRoutes: Array.from(consumedRoutes)
    };

    const outPath = path.join(repoPath, '.codebase', 'api_registry.json');
    fs.writeFileSync(outPath, JSON.stringify(registry, null, 2), 'utf8');

    return registry;
  }
}
