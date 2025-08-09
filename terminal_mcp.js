#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { spawn } = require('child_process');
const os = require('os');

const server = new Server(
  {
    name: 'terminal-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: true
    },
  }
);

let shellProcess = null;
let currentWorkingDirectory = process.cwd();

function initializeShell() {
  if (shellProcess) {
    shellProcess.kill();
  }

  shellProcess = spawn('cmd.exe', ['/Q'], {
    cwd: currentWorkingDirectory,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  shellProcess.on('error', (error) => {
    console.error('Shell process error:', error);
    shellProcess = null;
  });

  // Set higher limit for listeners
  shellProcess.stdout.setMaxListeners(20);
  shellProcess.stderr.setMaxListeners(20);
}

function executeCommand(command, timeout = 30000) {
  return new Promise((resolve) => {
    if (!shellProcess || shellProcess.killed) {
      initializeShell();
    }

    const chunks = [];
    const errorChunks = [];
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        cleanup();
        resolve({
          success: false,
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(errorChunks).toString() + '\nCommand timed out',
          exitCode: -1
        });
      }
    }, timeout);

    const onData = (data) => {
      chunks.push(data);
    };

    const onErrorData = (data) => {
      errorChunks.push(data);
    };

    const cleanup = () => {
      shellProcess.stdout.removeListener('data', onData);
      shellProcess.stderr.removeListener('data', onErrorData);
      clearTimeout(timeoutId);
    };

    const marker = `__COMMAND_COMPLETE_${Date.now()}__`;

    shellProcess.stdout.on('data', onData);
    shellProcess.stderr.on('data', onErrorData);

    const checkOutput = setInterval(() => {
      const output = Buffer.concat(chunks).toString();
      if (output.includes(marker)) {
        clearInterval(checkOutput);
        if (!completed) {
          completed = true;
          cleanup();
          const stdout = output.replace(marker, '').trim();
          resolve({
            success: true,
            stdout,
            stderr: Buffer.concat(errorChunks).toString(),
            exitCode: 0
          });
        }
      }
    }, 10);

    setTimeout(() => clearInterval(checkOutput), timeout);

    shellProcess.stdin.write(`${command} && echo ${marker}\r\n`);
  });
}

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute_command',
        description: 'Execute a shell command',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Command to execute'
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds',
              default: 30000
            }
          },
          required: ['command']
        }
      }
    ]
  };
});

// Handle command execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'execute_command') {
    throw new Error('Unknown tool');
  }

  const result = await executeCommand(args.command, args.timeout);
  
  return {
    content: [
      {
        type: 'text',
        text: result.stdout
      }
    ],
    isError: !result.success
  };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Terminal MCP server running on stdio');
  initializeShell();
}

process.on('exit', () => {
  if (shellProcess) {
    shellProcess.kill();
  }
});

process.on('SIGINT', () => {
  if (shellProcess) {
    shellProcess.kill();
  }
  process.exit(0);
});

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});