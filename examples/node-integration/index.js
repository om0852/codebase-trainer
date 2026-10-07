/**
 * Example: Integrating Codebase Trainer in a custom Node.js application
 * 
 * This script demonstrates how you can spawn the codebase-trainer CLI
 * programmatically to extract architectural context or run a search.
 */

import { spawn } from 'child_process';

async function runCodebaseTrainerSearch(query) {
    console.log(`🔍 Searching Codebase Trainer for: "${query}"...\n`);
    
    return new Promise((resolve, reject) => {
        // Spawns the CLI in the current workspace
        const cb = spawn('npx', ['cb-trainer', 'search', query]);

        let output = '';
        
        cb.stdout.on('data', (data) => {
            output += data.toString();
        });

        cb.stderr.on('data', (data) => {
            console.error(`Error: ${data}`);
        });

        cb.on('close', (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
    });
}

// Execute the example
(async () => {
    try {
        const result = await runCodebaseTrainerSearch("authentication logic");
        console.log("=== RESULTS ===");
        console.log(result);
    } catch (error) {
        console.error("Failed to run Codebase Trainer:", error);
    }
})();
