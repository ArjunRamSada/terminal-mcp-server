const { spawn } = require('child_process');

async function runCommand(server, command) {
    return new Promise((resolve, reject) => {
        const request = {
            jsonrpc: "2.0",
            id: Date.now().toString(),
            method: "tools/call",
            params: {
                name: "execute_command",
                arguments: {
                    command: command
                }
            }
        };

        const onData = (data) => {
            try {
                const response = JSON.parse(data.toString());
                if (response.error) {
                    server.stdout.removeListener('data', onData);
                    reject(new Error(response.error.message));
                } else {
                    server.stdout.removeListener('data', onData);
                    resolve(response);
                }
            } catch (e) {
                // Ignore parse errors for partial data
            }
        };

        server.stdout.on('data', onData);
        server.stdin.write(JSON.stringify(request) + '\n');

        // Timeout safety
        setTimeout(() => {
            server.stdout.removeListener('data', onData);
            reject(new Error('Command timeout'));
        }, 5000);
    });
}

async function performanceTest() {
    console.log('Starting performance tests...\n');
    
    const server = spawn('node', ['terminal_mcp.js'], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    const onError = data => {
        console.error(`Server stderr: ${data}`);
    };

    server.stderr.on('data', onError);

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    const testCases = [
        {
            name: "Simple echo",
            command: "echo test",
            iterations: 5
        },
        {
            name: "Directory listing",
            command: "dir",
            iterations: 5
        },
        {
            name: "Multiple commands",
            command: "cd && echo test && dir",
            iterations: 5
        }
    ];

    try {
        for (const test of testCases) {
            console.log(`Test: ${test.name}`);
            const times = [];

            for (let i = 0; i < test.iterations; i++) {
                const start = Date.now();
                await runCommand(server, test.command);
                const duration = Date.now() - start;
                times.push(duration);
                console.log(`  Iteration ${i + 1}: ${duration}ms`);
            }

            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            const min = Math.min(...times);
            const max = Math.max(...times);

            console.log(`\nResults for ${test.name}:`);
            console.log(`  Average: ${avg.toFixed(2)}ms`);
            console.log(`  Min: ${min}ms`);
            console.log(`  Max: ${max}ms\n`);
        }
    } finally {
        server.stderr.removeListener('data', onError);
        server.kill();
    }
}

console.log('Running performance tests...');
performanceTest()
    .then(() => {
        console.log('Performance tests completed successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('Performance tests failed:', error);
        process.exit(1);
    });