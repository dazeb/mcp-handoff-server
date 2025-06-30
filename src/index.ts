import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tool input schemas and interfaces
interface MCPRequest {
  jsonrpc: string;
  method: string;
  params: any;
  id: number;
}

// Tool input schemas
const ReadHandoffInput = z.object({
  handoff_id: z.string(),
  format: z.enum(['full', 'summary']).optional().default('full')
});

const CreateHandoffInput = z.object({
  type: z.enum(['standard', 'quick']),
  initialData: z.object({
    date: z.string(),
    time: z.string(),
    currentState: z.object({
      workingOn: z.string(),
      status: z.string(),
      nextStep: z.string()
    }),
    projectContext: z.string().optional(),
    environmentStatus: z.object({
      details: z.record(z.enum(['✅', '⚠️', '❌']))
    })
  })
});

const UpdateHandoffInput = z.object({
  handoff_id: z.string(),
  updates: z.array(z.object({
    section: z.enum(['progress', 'priorities', 'issues', 'environment', 'context']),
    content: z.record(z.any())
  }))
});

const CompleteHandoffInput = z.object({
  handoff_id: z.string(),
  completionData: z.object({
    endTime: z.string(),
    progress: z.array(z.string()),
    nextSteps: z.array(z.string()),
    archiveReason: z.string().optional()
  })
});

const ArchiveHandoffInput = z.object({
  handoff_id: z.string(),
  metadata: z.object({
    reason: z.string(),
    tags: z.array(z.string()),
    completionStatus: z.enum(['success', 'partial', 'blocked'])
  })
});

const ListHandoffsInput = z.object({
  status: z.enum(['active', 'archived', 'all']),
  type: z.enum(['standard', 'quick']).optional(),
  filters: z.object({
    dateRange: z.object({
      start: z.string(),
      end: z.string()
    }).optional(),
    tags: z.array(z.string()).optional(),
    hasIssues: z.boolean().optional()
  }).optional()
});

export class HandoffMCPServer {
  private app: express.Application;
  private port: number;
  private handoffRoot: string;

  constructor(
    port: number = parseInt(process.env.PORT || '3001', 10),
    handoffRoot: string = process.env.HANDOFF_ROOT || '../handoff-system'
  ) {
    this.app = express();
    this.port = port;
    this.handoffRoot = handoffRoot;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
  }

  private setupRoutes() {
    this.app.post('/mcp', this.handleMCPRequest.bind(this));
    this.app.get('/health', (_, res) => {
      res.json({ status: 'healthy' });
    });
  }

  public async initializeFileSystem() {
    // Create base directories
    const directories = ['active', 'archive', 'templates'];
    for (const dir of directories) {
      const dirPath = path.join(this.handoffRoot, dir);
      await fs.mkdir(dirPath, { recursive: true });
    }

    // Create template files if they don't exist
    const standardTemplate = path.join(this.handoffRoot, 'templates', 'handoff-template.md');
    const quickTemplate = path.join(this.handoffRoot, 'templates', 'quick-handoff.md');

    const templates = {
      [standardTemplate]: `# MCPaaS.dev Agent Handoff Document

**Date**: [YYYY-MM-DD]  
**Time**: [HH:MM UTC]  
**Session Duration**: [X hours]  
**Outgoing Agent**: [Agent ID/Name]  
**Incoming Agent**: [To be filled by next agent]

---

## 🎯 Project Context
**Current Focus**: [Brief description of main objective]
**Status**: [Current state of work]

## ✅ Recent Progress
- [Completed item 1]
- [Completed item 2]

## 🔄 Active Work
**Working On**: [Current primary task]  
**Status**: [How far along]  
**Next Step**: [Very specific next action]

## 🌍 Environment Status
- **Server**: ✅/⚠️/❌ [Status details]
- **Database**: ✅/⚠️/❌ [Status details]
- **Cache**: ✅/⚠️/❌ [Status details]

## ⚠️ Known Issues
- [Issue description]
- [Another issue]`,
      [quickTemplate]: `# Quick Handoff - MCPaaS.dev

**Date**: [YYYY-MM-DD HH:MM UTC]  
**Duration**: [X minutes/hours]

---

## 🎯 Current State
**Working On**: [Current primary task]  
**Status**: [How far along]  
**Next Step**: [Very specific next action]

## ✅ Just Completed
1. [Most recent accomplishment]
2. [Another recent accomplishment]

## 🔥 Immediate Priorities
1. [Critical task 1]
2. [Critical task 2]

## 🌍 Environment Status
- **Server**: ✅/⚠️/❌ [Status]
- **Database**: ✅/⚠️/❌ [Status]
- **Cache**: ✅/⚠️/❌ [Status]`
    };

    for (const [filepath, content] of Object.entries(templates)) {
      try {
        await fs.access(filepath);
      } catch {
        await fs.writeFile(filepath, content, 'utf-8');
      }
    }

    console.log('Handoff system initialized with required directories and templates');
  }

  public async readHandoff(params: z.infer<typeof ReadHandoffInput>) {
    const filePath = this.resolveHandoffPath(params.handoff_id);
    const content = await fs.readFile(filePath, 'utf-8');
    
    if (params.format === 'summary') {
      return this.createHandoffSummary(content);
    }
    
    return {
      content,
      metadata: await this.getHandoffMetadata(params.handoff_id)
    };
  }

  public async createHandoff(params: z.infer<typeof CreateHandoffInput>) {
    const template = await this.loadTemplate(params.type);
    const content = this.populateTemplate(template, params.initialData);
    const handoff_id = this.generateHandoffId(params.initialData.date);
    const filepath = this.resolveHandoffPath(handoff_id);

    await this.ensureDirectoryExists(filepath);
    await fs.writeFile(filepath, content, 'utf-8');

    return {
      handoff_id,
      filepath,
      status: 'created'
    };
  }

  public async updateHandoff(params: z.infer<typeof UpdateHandoffInput>) {
    const filePath = this.resolveHandoffPath(params.handoff_id);
    const content = await fs.readFile(filePath, 'utf-8');
    const updatedContent = this.applyUpdates(content, params.updates);
    await fs.writeFile(filePath, updatedContent, 'utf-8');

    return {
      status: 'updated',
      modifiedSections: params.updates.map(u => u.section)
    };
  }

  public async completeHandoff(params: z.infer<typeof CompleteHandoffInput>) {
    const filePath = this.resolveHandoffPath(params.handoff_id);
    const content = await fs.readFile(filePath, 'utf-8');
    
    const updatedContent = this.applyUpdates(content, [{
      section: 'progress',
      content: {
        completionTime: params.completionData.endTime,
        completedItems: params.completionData.progress
      }
    }]);

    await fs.writeFile(filePath, updatedContent, 'utf-8');

    if (params.completionData.archiveReason) {
      await this.archiveHandoff({
        handoff_id: params.handoff_id,
        metadata: {
          reason: params.completionData.archiveReason,
          tags: ['completed'],
          completionStatus: 'success'
        }
      });
      return { status: 'completed', archived: true };
    }

    return { status: 'completed', archived: false };
  }

  public async archiveHandoff(params: z.infer<typeof ArchiveHandoffInput>) {
    const sourceFilePath = this.resolveHandoffPath(params.handoff_id);
    const archivePath = path.join(this.handoffRoot, 'archive', `${params.handoff_id}.md`);

    const content = await fs.readFile(sourceFilePath, 'utf-8');
    const updatedContent = this.addArchiveMetadata(content, params.metadata);

    await this.ensureDirectoryExists(archivePath);
    await fs.writeFile(archivePath, updatedContent, 'utf-8');
    await fs.unlink(sourceFilePath);

    return { 
      status: 'archived',
      archivePath
    };
  }

  private resolveHandoffPath(handoff_id: string): string {
    return path.join(this.handoffRoot, 'active', `${handoff_id}.md`);
  }

  private async loadTemplate(type: 'standard' | 'quick'): Promise<string> {
    const templatePath = path.join(
      this.handoffRoot,
      'templates',
      type === 'standard' ? 'handoff-template.md' : 'quick-handoff.md'
    );
    return fs.readFile(templatePath, 'utf-8');
  }

  private async ensureDirectoryExists(filepath: string) {
    const dir = filepath.substring(0, filepath.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });
  }

  private generateHandoffId(date: string): string {
    return `${date}-${Math.random().toString(36).substring(2, 7)}`;
  }

  private async getHandoffMetadata(handoff_id: string) {
    const filePath = this.resolveHandoffPath(handoff_id);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const metadata: Record<string, any> = {};
    for (const line of lines) {
      if (line.startsWith('**') && line.includes(':')) {
        const [key, value] = line.replace(/\*\*/g, '').split(':').map(s => s.trim());
        metadata[this.camelCase(key)] = value;
      }
      if (line.startsWith('---')) break;
    }

    return metadata;
  }

  private createHandoffSummary(content: string) {
    const lines = content.split('\n');
    const summary: Record<string, any> = {};
    let currentSection = '';

    for (const line of lines) {
      if (line.startsWith('## ')) {
        currentSection = this.camelCase(line.replace('## ', '').trim());
        summary[currentSection] = [];
      } else if (currentSection && line.trim() && !line.startsWith('---')) {
        if (line.startsWith('- ') || line.startsWith('* ')) {
          summary[currentSection].push(line.substring(2).trim());
        }
      }
    }

    return summary;
  }

  private populateTemplate(template: string, data: any): string {
    let populated = template;

    populated = populated.replace('[YYYY-MM-DD]', data.date);
    populated = populated.replace('[HH:MM UTC]', data.time);
    populated = populated.replace('[Current primary task]', data.currentState.workingOn);
    populated = populated.replace('[How far along]', data.currentState.status);
    populated = populated.replace('[Very specific next action]', data.currentState.nextStep);

    if (data.projectContext) {
      populated = populated.replace('[Brief description of main objective]', data.projectContext);
    }

    Object.entries(data.environmentStatus.details).forEach(([key, status]) => {
      const placeholder = new RegExp(`${key}.*: ✅/⚠️/❌`);
      populated = populated.replace(placeholder, `${key}: ${status}`);
    });

    return populated;
  }

  private applyUpdates(content: string, updates: any[]): string {
    const lines = content.split('\n');
    
    for (const update of updates) {
      const sectionStart = lines.findIndex(line => 
        line.toLowerCase().includes(update.section.toLowerCase())
      );

      if (sectionStart === -1) continue;

      const sectionEnd = lines.findIndex((line, i) => 
        i > sectionStart && line.startsWith('## ')
      );

      const end = sectionEnd === -1 ? lines.length : sectionEnd;
      const formattedContent = this.formatSectionContent(update.section, update.content);
      
      lines.splice(
        sectionStart + 1,
        end - (sectionStart + 1),
        formattedContent
      );
    }

    return lines.join('\n');
  }

  private formatSectionContent(section: string, content: Record<string, any>): string {
    let formatted = '';

    switch (section) {
      case 'progress':
        if (content.completionTime) {
          formatted += `\n**Completion Time**: ${content.completionTime}\n\n`;
        }
        if (content.completedItems) {
          formatted += '### Completed Items\n';
          content.completedItems.forEach((item: string) => {
            formatted += `- ${item}\n`;
          });
        }
        break;

      case 'priorities':
        formatted += '\n### High Priority\n';
        if (content.highPriority) {
          content.highPriority.forEach((item: string) => {
            formatted += `- ${item}\n`;
          });
        }
        if (content.mediumPriority) {
          formatted += '\n### Medium Priority\n';
          content.mediumPriority.forEach((item: string) => {
            formatted += `- ${item}\n`;
          });
        }
        break;

      case 'issues':
        if (content.critical) {
          formatted += '\n### Critical Issues\n';
          content.critical.forEach((issue: string) => {
            formatted += `- ❗ ${issue}\n`;
          });
        }
        if (content.nonCritical) {
          formatted += '\n### Non-Critical Issues\n';
          content.nonCritical.forEach((issue: string) => {
            formatted += `- ⚠️ ${issue}\n`;
          });
        }
        break;

      case 'environment':
        Object.entries(content).forEach(([key, status]) => {
          formatted += `\n- **${key}**: ${status}`;
        });
        break;

      case 'context':
        Object.entries(content).forEach(([key, value]) => {
          formatted += `\n### ${key}\n${value}\n`;
        });
        break;
    }

    return formatted;
  }

  private addArchiveMetadata(content: string, metadata: z.infer<typeof ArchiveHandoffInput>['metadata']): string {
    const lines = content.split('\n');
    const archiveMetadata = [
      '## 📦 Archive Information',
      `**Archive Date**: ${new Date().toISOString()}`,
      `**Archive Reason**: ${metadata.reason}`,
      `**Completion Status**: ${metadata.completionStatus}`,
      `**Tags**: ${metadata.tags.join(', ')}`,
      ''
    ];

    const headerEnd = lines.findIndex(line => line.startsWith('---')) + 1;
    lines.splice(headerEnd, 0, ...archiveMetadata);
    
    return lines.join('\n');
  }

  private parseHandoffInfo(content: string) {
    const lines = content.split('\n');
    const info = {
      id: '',
      type: 'standard' as ('standard' | 'quick'),
      title: '',
      date: '',
      status: '',
      priority: 0
    };

    for (const line of lines) {
      if (line.startsWith('**Date**:')) {
        info.date = line.split(':')[1].trim();
      } else if (line.startsWith('# ')) {
        info.title = line.substring(2).trim();
      } else if (line.includes('Priority Queue')) {
        info.priority = this.extractPriority(content);
      } else if (line.includes('Quick Handoff')) {
        info.type = 'quick';
      }
      if (line.startsWith('---')) break;
    }

    info.id = info.date ? this.generateHandoffId(info.date) : 
      `handoff-${Math.random().toString(36).substring(2, 7)}`;

    return info;
  }

  private extractPriority(content: string): number {
    const priorityMatch = content.match(/🔥|⚡|📋|💡/g);
    if (!priorityMatch) return 0;

    const priorities = {
      '🔥': 4,
      '⚡': 3,
      '📋': 2,
      '💡': 1
    };

    return Math.max(...priorityMatch.map(emoji => priorities[emoji as keyof typeof priorities]));
  }

  private isInDateRange(date: string, range: { start: string; end: string }): boolean {
    const handoffDate = new Date(date);
    const start = new Date(range.start);
    const end = new Date(range.end);
    return handoffDate >= start && handoffDate <= end;
  }

  private hasIssues(content: string): boolean {
    return content.toLowerCase().includes('## ⚠️ known issues') && 
           !content.includes('No known issues');
  }

  private hasTags(content: string, tags: string[]): boolean {
    const contentLower = content.toLowerCase();
    return tags.some(tag => contentLower.includes(tag.toLowerCase()));
  }

  private camelCase(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
      .replace(/^[A-Z]/, c => c.toLowerCase());
  }

  public async listHandoffs(params: z.infer<typeof ListHandoffsInput>) {
    const handoffs: Array<{
      id: string;
      type: 'standard' | 'quick';
      title: string;
      date: string;
      status: string;
      priority: number;
    }> = [];

    const searchDirs = params.status === 'all' 
      ? ['active', 'archive']
      : [params.status === 'archived' ? 'archive' : 'active'];

    for (const dir of searchDirs) {
      const dirPath = path.join(this.handoffRoot, dir);
      try {
        const files = await fs.readdir(dirPath);
        
        for (const file of files) {
          if (!file.endsWith('.md')) continue;

          const filePath = path.join(dirPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const handoffInfo = this.parseHandoffInfo(content);

          if (params.type && handoffInfo.type !== params.type) continue;
          if (params.filters?.dateRange && !this.isInDateRange(handoffInfo.date, params.filters.dateRange)) continue;
          if (params.filters?.hasIssues && !this.hasIssues(content)) continue;
          if (params.filters?.tags && !this.hasTags(content, params.filters.tags)) continue;

          handoffs.push(handoffInfo);
        }
      } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
      }
    }

    return { handoffs: handoffs.sort((a, b) => b.priority - a.priority) };
  }

  // Other private helper methods remain unchanged
  private async handleMCPRequest(req: express.Request, res: express.Response) {
    const { method, params } = req.body;

    try {
      switch (method) {
        case 'read_handoff': {
          const result = await this.readHandoff(ReadHandoffInput.parse(params));
          return res.json(this.createResponse(result));
        }
        case 'create_handoff': {
          const result = await this.createHandoff(CreateHandoffInput.parse(params));
          return res.json(this.createResponse(result));
        }
        case 'update_handoff': {
          const result = await this.updateHandoff(UpdateHandoffInput.parse(params));
          return res.json(this.createResponse(result));
        }
        case 'complete_handoff': {
          const result = await this.completeHandoff(CompleteHandoffInput.parse(params));
          return res.json(this.createResponse(result));
        }
        case 'archive_handoff': {
          const result = await this.archiveHandoff(ArchiveHandoffInput.parse(params));
          return res.json(this.createResponse(result));
        }
        case 'list_handoffs': {
          const result = await this.listHandoffs(ListHandoffsInput.parse(params));
          return res.json(this.createResponse(result));
        }
        default:
          throw new Error(`Unknown method: ${method}`);
      }
    } catch (error) {
      return res.status(400).json(this.createErrorResponse(error));
    }
  }

  private createResponse(result: any) {
    return {
      jsonrpc: '2.0',
      result,
      id: 1
    };
  }

  private createErrorResponse(error: any) {
    const err = error as Error;
    return {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: err.message || 'Internal server error',
        data: err
      },
      id: 1
    };
  }

  public async start() {
    await this.initializeFileSystem();
    this.app.listen(this.port, () => {
      console.log(`Handoff MCP Server running on port ${this.port}`);
    });
  }
}

// Handle MCP requests from stdin
export async function handleStdinMCP() {
  const readline = (await import('readline')).createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const server = new HandoffMCPServer();
  await server.initializeFileSystem();

  readline.on('line', async (line) => {
    try {
      const request: MCPRequest = JSON.parse(line);
      const { method, params, id } = request;
      let result: any;

      switch (method) {
        case 'read_handoff':
          result = await server.readHandoff(ReadHandoffInput.parse(params));
          break;
        case 'create_handoff':
          result = await server.createHandoff(CreateHandoffInput.parse(params));
          break;
        case 'update_handoff':
          result = await server.updateHandoff(UpdateHandoffInput.parse(params));
          break;
        case 'complete_handoff':
          result = await server.completeHandoff(CompleteHandoffInput.parse(params));
          break;
        case 'archive_handoff':
          result = await server.archiveHandoff(ArchiveHandoffInput.parse(params));
          break;
        case 'list_handoffs':
          result = await server.listHandoffs(ListHandoffsInput.parse(params));
          break;
        default:
          throw new Error(`Unknown method: ${method}`);
      }

      console.log(JSON.stringify({
        jsonrpc: '2.0',
        result,
        id
      }));
    } catch (error) {
      const err = error as Error;
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: err.message || 'Internal server error',
          data: err
        },
        id: (error as any)?.request?.id || 1
      }));
    }
  });
}

// Determine whether to run in HTTP or stdio mode
if (process.env.HTTP_MODE === 'true') {
  const server = new HandoffMCPServer();
  server.start().catch(console.error);
} else {
  handleStdinMCP().catch(console.error);
}
