"""
Example: Integrating Codebase Trainer MCP with Python LangChain

This script demonstrates how an AI agent built in Python can connect to 
the local `codebase-trainer` MCP server to fetch repository facts dynamically.

Prerequisites:
pip install langchain langchain-experimental
"""

import os
import subprocess
from langchain_core.messages import HumanMessage
from langchain.chat_models import init_chat_model

def get_mcp_context():
    """
    Simulates calling the Codebase Trainer MCP CLI to fetch the context pack.
    In a real LangChain MCP setup, you would use the official MCP LangChain wrapper.
    """
    print("🔌 Connecting to local Codebase Trainer MCP...")
    try:
        # Request context pack via CLI (or via MCP stdio pipeline)
        result = subprocess.run(
            ["npx", "cb-trainer", "context", "auth middleware"], 
            capture_output=True, 
            text=True
        )
        return result.stdout
    except Exception as e:
        return str(e)

def main():
    print("🚀 Initializing AI Agent...")
    
    # 1. Fetch live repository context from codebase-trainer
    repo_context = get_mcp_context()
    print("✅ Context retrieved successfully.")

    # 2. Inject context into LLM prompt
    prompt = f"""
    You are an expert software engineer.
    Based on the following repository rules and AST facts:
    
    {repo_context}
    
    How should I implement a new login route?
    """

    print("🤖 Agent Prompt Constructed. Ready to send to LLM.\n")
    print("--- PROMPT PREVIEW ---")
    print(prompt)

if __name__ == "__main__":
    main()
