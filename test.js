const { spawn } = require('child_process');

async function testMCP() {
    return new Promise((resolve, reject) => {
        const server = spawn('node', ['terminal_mcp.js'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let dataReceived = false;

        server.stderr.on('data', data => {
            console.error(`Server stderr: ${data}`);
        });

        server.stdout.on('data', data => {
            dataReceived = true;
            try {
                const response = JSON.parse(data.toString());
                console.log('Received response:', response);
                if (response.error) {
                    server.kill();
                    reject(new Error(response.error.message));
                } else if (response.result && response.result.content) {
                    console.log('Command output:', response.result.content[0].text);
                }
            } catch (e) {
                console.error('Parse error:', e);
            }
        });

        // Simple test command
        const testCommand = {
            jsonrpc: "2.0",
            id: "test1",
            method: "tools/call",
            params: {
                name: "execute_command",
                arguments: {
                    command: "echo test"
                }
            }
        };

        // Wait for server to start
        setTimeout(() => {
            console.log('Sending command:', JSON.stringify(testCommand));
            server.stdin.write(JSON.stringify(testCommand) + '\n');
            
            // Give time for response
            setTimeout(() => {
                server.kill();
                if (!dataReceived) {
                    reject(new Error('No response received'));
                } else {
                    resolve();
                }
            }, 1000);
        }, 1000);
    });
}

console.log('Starting test...');
testMCP()
    .then(() => {
        console.log('Test completed successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
    });