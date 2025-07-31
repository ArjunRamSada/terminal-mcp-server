# MCP Terminal

This project provides a server that exposes shell command execution through the Model Context Protocol (MCP). It allows a client to send shell commands to the server, which then executes them in a persistent shell session, maintaining the current working directory across commands.

## Installation

1. Clone the repository.
2. Install the dependencies:

```bash
npm install
```

## Usage

Run the server using the following command:

```bash
node terminal_mcp.js
```

The server listens for requests to execute shell commands. It supports the following tools:

### `execute_command`

Executes a shell command in a persistent shell session.

**Arguments:**

*   `command` (string, required): The command to execute.
*   `timeout` (number, optional): Timeout in milliseconds (default: 30000).
*   `use_persistent_shell` (boolean, optional): Use persistent shell session (default: true).

### `reset_shell`

Resets the persistent shell session.

## License

This project is licensed under the ISC License.
