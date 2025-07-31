#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const server = new Server(
  {
    name: 'terminal-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Persistent shell process
let shellProcess = null;
let currentWorkingDirectory = process.cwd();
let shellEnvironment = { ...process.env };

// Initialize persistent shell
function initializeShell() {
  if (shellProcess) {
    shellProcess.kill();
  }

  const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
  const shellArgs = os.platform() === 'win32' ? ['/Q'] : ['-i'];

  shellProcess = spawn(shell, shellArgs, {
    cwd: currentWorkingDirectory,
    env: shellEnvironment,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  shellProcess.on('error', (error) => {
    console.error('Shell process error:', error);
    shellProcess = null;
  });

  shellProcess.on('exit', (code) => {
    console.error('Shell process exited with code:', code);
    shellProcess = null;
  });

  // Set up shell for interactive use
  if (os.platform() !== 'win32') {
    shellProcess.stdin.write('export PS1=""\n'); // Remove prompt to avoid confusion
    shellProcess.stdin.write('set +H\n'); // Disable history expansion
  }
}

// Execute command in persistent shell
function executeCommandInShell(command, timeout = 30000) {
  return new Promise((resolve) => {
    if (!shellProcess || shellProcess.killed) {
      initializeShell();
    }

    let stdout = '';
    let stderr = '';
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        resolve({
          success: false,
          stdout: stdout,
          stderr: stderr + '\nCommand timed out',
          exitCode: -1,
          error: 'Command timed out'
        });
      }
    }, timeout);

    // Create a unique marker to detect command completion
    const marker = `__COMMAND_COMPLETE_${Date.now()}__`;
    const errorMarker = `__COMMAND_ERROR_${Date.now()}__`;

    const onData = (data) => {
      const output = data.toString();
      stdout += output;
      
      if (output.includes(marker)) {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          shellProcess.stdout.removeListener('data', onData);
          shellProcess.stderr.removeListener('data', onErrorData);
          
          // Clean up the markers from output
          stdout = stdout.replace(new RegExp(marker, 'g'), '').trim();
          stderr = stderr.replace(new RegExp(errorMarker, 'g'), '').trim();
          
          resolve({
            success: true,
            stdout: stdout,
            stderr: stderr,
            exitCode: 0
          });
        }
      }
    };

    const onErrorData = (data) => {
      stderr += data.toString();
    };

    shellProcess.stdout.on('data', onData);
    shellProcess.stderr.on('data', onErrorData);

    // Execute the command with markers
    if (os.platform() === 'win32') {
      shellProcess.stdin.write(`${command} && echo ${marker} || echo ${errorMarker}\n`);
    } else {
      shellProcess.stdin.write(`${command}; echo "${marker}"\n`);
    }
  });
}

// Alternative: Track directory changes manually
function updateWorkingDirectory(command) {
  const cdMatch = command.match(/^\s*cd\s+(.*)$/);
  if (cdMatch) {
    let targetDir = cdMatch[1].trim();
    
    // Handle quoted paths
    if ((targetDir.startsWith('"') && targetDir.endsWith('"')) ||
        (targetDir.startsWith("'") && targetDir.endsWith("'"))) {
      targetDir = targetDir.slice(1, -1);
    }
    
    // Handle relative paths
    if (!path.isAbsolute(targetDir)) {
      if (targetDir === '..') {
        currentWorkingDirectory = path.dirname(currentWorkingDirectory);
      } else if (targetDir === '~') {
        currentWorkingDirectory = os.homedir();
      } else if (targetDir.startsWith('~/')) {
        currentWorkingDirectory = path.join(os.homedir(), targetDir.slice(2));
      } else {
        currentWorkingDirectory = path.resolve(currentWorkingDirectory, targetDir);
      }
    } else {
      currentWorkingDirectory = targetDir;
    }
  }
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute_command',
        description: 'Execute a shell command in a persistent shell session',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Command to execute',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 30000)',
              default: 30000,
            },
            use_persistent_shell: {
              type: 'boolean',
              description: 'Use persistent shell session (default: true)',
              default: true,
            },
          },
          required: ['command'],
        }
      },
      {
        name: 'reset_shell',
        description: 'Reset the persistent shell session',
        inputSchema: {
          type: 'object',
          properties: {},
        }
      }
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'execute_command': {
        let result;
        
        if (args.use_persistent_shell !== true) {
          // Use persistent shell
          result = await executeCommandInShell(args.command, args.timeout);
        } else {
          // Fall back to individual exec calls with manual directory tracking
          updateWorkingDirectory(args.command);
          
          const { exec } = require('child_process');
          result = await new Promise((resolve) => {
            exec(args.command, {
              cwd: currentWorkingDirectory,
              timeout: args.timeout || 30000,
              maxBuffer: 1024 * 1024,
              env: shellEnvironment
            }, (error, stdout, stderr) => {
              if (error) {
                resolve({
                  success: false,
                  stdout: stdout,
                  stderr: stderr,
                  exitCode: error.code,
                  error: error.message
                });
              } else {
                resolve({
                  success: true,
                  stdout: stdout,
                  stderr: stderr,
                  exitCode: 0
                });
              }
            });
          });
        }
        
        let output = `Command: ${args.command}\n`;
        output += `Working Directory: ${currentWorkingDirectory}\n`;
        output += `Exit Code: ${result.exitCode}\n\n`;
        
        if (result.stdout) {
          output += `STDOUT:\n${result.stdout}\n`;
        }
        
        if (result.stderr) {
          output += `STDERR:\n${result.stderr}\n`;
        }
        
        if (result.error) {
          output += `ERROR: ${result.error}\n`;
        }

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
          isError: !result.success,
        };
      }

      case 'reset_shell': {
        if (shellProcess) {
          shellProcess.kill();
          shellProcess = null;
        }
        currentWorkingDirectory = process.cwd();
        shellEnvironment = { ...process.env };
        
        return {
          content: [
            {
              type: 'text',
              text: 'Shell session reset successfully',
            },
          ],
          isError: false,
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
      },
      ],
      isError: true,
    };
  }
});

// Clean up on exit
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Terminal MCP server running on stdio');
  
  // Initialize the persistent shell
  initializeShell();
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});