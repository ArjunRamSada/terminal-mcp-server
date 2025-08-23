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
    name: 'multi-terminal-server',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Terminal session management
class TerminalSession {
  constructor(id, options = {}) {
    this.id = id;
    this.process = null;
    this.workingDirectory = options.cwd || process.cwd();
    this.environment = { ...process.env, ...options.env };
    this.isActive = false;
    this.lastActivity = Date.now();
    this.shell = options.shell || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash');
    this.shellArgs = options.shellArgs || (os.platform() === 'win32' ? ['/Q'] : ['-i']);
  }

  initialize() {
    if (this.process) {
      this.kill();
    }

    this.process = spawn(this.shell, this.shellArgs, {
      cwd: this.workingDirectory,
      env: this.environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.isActive = true;
    this.lastActivity = Date.now();

    this.process.on('error', (error) => {
      console.error(`Terminal ${this.id} error:`, error);
      this.isActive = false;
    });

    this.process.on('exit', (code) => {
      console.error(`Terminal ${this.id} exited with code:`, code);
      this.isActive = false;
    });

    // Set up shell for interactive use (Unix only)
    if (os.platform() !== 'win32') {
      this.process.stdin.write('export PS1=""\n'); // Remove prompt
      this.process.stdin.write('set +H\n'); // Disable history expansion
    }

    return this;
  }

  async executeCommand(command, timeout = 30000) {
    if (!this.isActive || !this.process || this.process.killed) {
      this.initialize();
    }

    this.lastActivity = Date.now();

    return new Promise((resolve) => {
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

      // Create unique markers for this command
      const marker = `__COMMAND_COMPLETE_${this.id}_${Date.now()}__`;
      const errorMarker = `__COMMAND_ERROR_${this.id}_${Date.now()}__`;

      const onData = (data) => {
        const output = data.toString();
        stdout += output;
        
        if (output.includes(marker)) {
          if (!completed) {
            completed = true;
            clearTimeout(timeoutId);
            this.process.stdout.removeListener('data', onData);
            this.process.stderr.removeListener('data', onErrorData);
            
            // Clean up markers
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

      this.process.stdout.on('data', onData);
      this.process.stderr.on('data', onErrorData);

      // Execute command with markers
      if (os.platform() === 'win32') {
        this.process.stdin.write(`${command} && echo ${marker} || echo ${errorMarker}\n`);
      } else {
        this.process.stdin.write(`${command}; echo "${marker}"\n`);
      }

      // Update working directory if it's a cd command
      this.updateWorkingDirectory(command);
    });
  }

  updateWorkingDirectory(command) {
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
          this.workingDirectory = path.dirname(this.workingDirectory);
        } else if (targetDir === '~') {
          this.workingDirectory = os.homedir();
        } else if (targetDir.startsWith('~/')) {
          this.workingDirectory = path.join(os.homedir(), targetDir.slice(2));
        } else {
          this.workingDirectory = path.resolve(this.workingDirectory, targetDir);
        }
      } else {
        this.workingDirectory = targetDir;
      }
    }
  }

  kill() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.isActive = false;
    this.process = null;
  }

  getStatus() {
    return {
      id: this.id,
      isActive: this.isActive,
      workingDirectory: this.workingDirectory,
      shell: this.shell,
      lastActivity: this.lastActivity,
      pid: this.process ? this.process.pid : null
    };
  }
}

// Terminal session manager
class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this.nextId = 1;
    
    // Cleanup inactive sessions every 30 minutes
    setInterval(() => {
      this.cleanupInactiveSessions();
    }, 30 * 60 * 1000);
  }

  createSession(options = {}) {
    const id = options.id || `terminal_${this.nextId++}`;
    
    if (this.sessions.has(id)) {
      throw new Error(`Terminal session '${id}' already exists`);
    }

    const session = new TerminalSession(id, options);
    this.sessions.set(id, session);
    
    return session;
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Terminal session '${id}' not found`);
    }
    return session;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(session => session.getStatus());
  }

  closeSession(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
      return true;
    }
    return false;
  }

  closeAllSessions() {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }

  cleanupInactiveSessions(maxAge = 60 * 60 * 1000) { // 1 hour default
    const now = Date.now();
    const toRemove = [];

    for (const [id, session] of this.sessions.entries()) {
      if (!session.isActive || (now - session.lastActivity) > maxAge) {
        session.kill();
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.sessions.delete(id);
    }

    if (toRemove.length > 0) {
      console.error(`Cleaned up ${toRemove.length} inactive terminal sessions`);
    }
  }
}

const terminalManager = new TerminalManager();

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'create_terminal',
        description: 'Create a new terminal session',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Optional terminal ID (auto-generated if not provided)',
            },
            cwd: {
              type: 'string',
              description: 'Starting working directory (default: current directory)',
            },
            shell: {
              type: 'string',
              description: 'Shell to use (default: system default)',
            },
            env: {
              type: 'object',
              description: 'Additional environment variables',
            },
          },
        }
      },
      {
        name: 'execute_command',
        description: 'Execute a command in a specific terminal session',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: 'Terminal session ID',
            },
            command: {
              type: 'string',
              description: 'Command to execute',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 30000)',
              default: 30000,
            },
          },
          required: ['terminal_id', 'command'],
        }
      },
      {
        name: 'list_terminals',
        description: 'List all terminal sessions',
        inputSchema: {
          type: 'object',
          properties: {},
        }
      },
      {
        name: 'close_terminal',
        description: 'Close a specific terminal session',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: 'Terminal session ID to close',
            },
          },
          required: ['terminal_id'],
        }
      },
      {
        name: 'close_all_terminals',
        description: 'Close all terminal sessions',
        inputSchema: {
          type: 'object',
          properties: {},
        }
      },
      {
        name: 'get_terminal_status',
        description: 'Get status information for a specific terminal',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: 'Terminal session ID',
            },
          },
          required: ['terminal_id'],
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
      case 'create_terminal': {
        const session = terminalManager.createSession(args);
        session.initialize();
        
        const pwdResult = await session.executeCommand('pwd');
        const finalPwd = pwdResult.stdout.trim();

        return {
          content: [
            {
              type: 'text',
              text: `Terminal session '${session.id}' created successfully\n` +
                    `Working Directory: ${session.workingDirectory}\n` +
                    `Shell: ${session.shell}\n` +
                    `PID: ${session.process ? session.process.pid : 'N/A'}\n` +
                    `PWD: ${finalPwd}`,
            },
          ],
          isError: false,
        };
      }

      case 'execute_command': {
        const session = terminalManager.getSession(args.terminal_id);
        const result = await session.executeCommand(args.command, args.timeout);
        
        const pwdResult = await session.executeCommand('pwd');
        const finalPwd = pwdResult.stdout.trim();
        
        let output = `Terminal: ${args.terminal_id}\n`;
        output += `Command: ${args.command}\n`;
        output += `Working Directory: ${session.workingDirectory}\n`;
        output += `Exit Code: ${result.exitCode}\n\n`;
        output += `PWD: ${finalPwd}\n`;
        
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

      case 'list_terminals': {
        const sessions = terminalManager.listSessions();
        
        if (sessions.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No active terminal sessions',
              },
            ],
            isError: false,
          };
        }

        let output = 'Active Terminal Sessions:\n\n';
        for (const session of sessions) {
          output += `ID: ${session.id}\n`;
          output += `Status: ${session.isActive ? 'Active' : 'Inactive'}\n`;
          output += `Working Directory: ${session.workingDirectory}\n`;
          output += `Shell: ${session.shell}\n`;
          output += `PID: ${session.pid || 'N/A'}\n`;
          output += `Last Activity: ${new Date(session.lastActivity).toISOString()}\n`;
          output += '---\n';
        }

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
          isError: false,
        };
      }

      case 'close_terminal': {
        const closed = terminalManager.closeSession(args.terminal_id);
        
        return {
          content: [
            {
              type: 'text',
              text: closed 
                ? `Terminal session '${args.terminal_id}' closed successfully`
                : `Terminal session '${args.terminal_id}' not found`,
            },
          ],
          isError: !closed,
        };
      }

      case 'close_all_terminals': {
        const sessionCount = terminalManager.sessions.size;
        terminalManager.closeAllSessions();
        
        return {
          content: [
            {
              type: 'text',
              text: `Closed ${sessionCount} terminal session(s)`,
            },
          ],
          isError: false,
        };
      }

      case 'get_terminal_status': {
        const session = terminalManager.getSession(args.terminal_id);
        const status = session.getStatus();
        
        let output = `Terminal Status: ${status.id}\n`;
        output += `Active: ${status.isActive}\n`;
        output += `Working Directory: ${status.workingDirectory}\n`;
        output += `Shell: ${status.shell}\n`;
        output += `PID: ${status.pid || 'N/A'}\n`;
        output += `Last Activity: ${new Date(status.lastActivity).toISOString()}\n`;

        return {
          content: [
            {
              type: 'text',
              text: output,
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
  terminalManager.closeAllSessions();
});

process.on('SIGINT', () => {
  terminalManager.closeAllSessions();
  process.exit(0);
});

process.on('SIGTERM', () => {
  terminalManager.closeAllSessions();
  process.exit(0);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Multi-Terminal MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});