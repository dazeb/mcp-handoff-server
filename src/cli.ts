#!/usr/bin/env node

import 'dotenv/config';
import { HandoffMCPServer } from './index.js';

interface CLIOptions {
  mode: 'mcp' | 'http';
  port: number;
  handoffRoot: string;
  help: boolean;
  version: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    mode: 'mcp',
    port: parseInt(process.env.PORT || '3001', 10),
    handoffRoot: process.env.HANDOFF_ROOT || './handoff-system',
    help: false,
    version: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--mode':
      case '-m':
        const mode = args[++i];
        if (mode === 'http' || mode === 'mcp') {
          options.mode = mode;
        } else {
          console.error(`Invalid mode: ${mode}. Use 'http' or 'mcp'.`);
          process.exit(1);
        }
        break;
        
      case '--port':
      case '-p':
        const port = parseInt(args[++i], 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(`Invalid port: ${args[i]}. Must be a number between 1-65535.`);
          process.exit(1);
        }
        options.port = port;
        break;
        
      case '--handoff-root':
      case '-r':
        options.handoffRoot = args[++i];
        break;
        
      case '--help':
      case '-h':
        options.help = true;
        break;
        
      case '--version':
      case '-v':
        options.version = true;
        break;
        
      default:
        console.error(`Unknown option: ${arg}`);
        console.error('Use --help for usage information.');
        process.exit(1);
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
🤝 MCP Handoff Server - AI Agent Handoff Management

USAGE:
  npx mcp-handoff-server [OPTIONS]

OPTIONS:
  -m, --mode <mode>           Operation mode: 'mcp' or 'http' (default: mcp)
  -p, --port <port>           HTTP server port (default: 3001, only for http mode)
  -r, --handoff-root <path>   Path to handoff system directory (default: ./handoff-system)
  -h, --help                  Show this help message
  -v, --version               Show version information

EXAMPLES:
  # Run in MCP mode (default - communicates via stdin/stdout)
  npx mcp-handoff-server

  # Run HTTP server on default port (3001)
  npx mcp-handoff-server --mode http

  # Run HTTP server on custom port
  npx mcp-handoff-server --mode http --port 8080

  # Use custom handoff directory
  npx mcp-handoff-server --handoff-root /path/to/handoffs

  # Combine options
  npx mcp-handoff-server --mode http --port 3002 --handoff-root ./my-handoffs

MODES:
  mcp    Model Context Protocol mode - communicates via stdin/stdout
         Use this mode when integrating with MCP clients
         
  http   HTTP server mode - runs a REST API server
         Use this mode for direct HTTP API access or testing

ENVIRONMENT VARIABLES:
  PORT              Default port for HTTP mode (default: 3001)
  HANDOFF_ROOT      Default handoff system directory (default: ./handoff-system)
  HTTP_MODE         Set to 'true' to default to HTTP mode

For more information, visit: https://github.com/your-repo/mcp-handoff-server
`);
}

function showVersion(): void {
  console.log('MCP Handoff Server v1.0.0');
}

async function main(): Promise<void> {
  try {
    const options = parseArgs();

    if (options.help) {
      showHelp();
      process.exit(0);
    }

    if (options.version) {
      showVersion();
      process.exit(0);
    }

    console.log('🤝 Starting MCP Handoff Server...');
    console.log(`Mode: ${options.mode}`);
    console.log(`Handoff Root: ${options.handoffRoot}`);
    
    if (options.mode === 'http') {
      console.log(`Port: ${options.port}`);
      
      // Set environment variables for HTTP mode
      process.env.HTTP_MODE = 'true';
      process.env.PORT = options.port.toString();
      process.env.HANDOFF_ROOT = options.handoffRoot;
      
      const server = new HandoffMCPServer(options.port, options.handoffRoot);
      await server.start();
    } else {
      // MCP mode - set environment variables and run MCP handler
      process.env.HTTP_MODE = 'false';
      process.env.HANDOFF_ROOT = options.handoffRoot;
      
      console.log('Running in MCP mode - communicating via stdin/stdout');
      console.log('Send JSON-RPC 2.0 messages to interact with the server');
      
      // Import and run the MCP handler from the main file
      const { handleStdinMCP } = await import('./index.js');
      await handleStdinMCP();
    }
  } catch (error) {
    console.error('❌ Error starting MCP Handoff Server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down MCP Handoff Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down MCP Handoff Server...');
  process.exit(0);
});

// Run the CLI
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
