
import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentTool } from './agent.js'

const execAsync = promisify(exec)


/** 工具输出截取上限（行数），超过则截取尾部并提示 */
const MAX_OUTPUT_LINES = 200

let truncateCount = 0

/**
 * 截取工具输出：超过 maxLines 行时只保留尾部，完整输出存到临时文件。
 * 尾部优先——错误信息通常在末尾。
 */
async function truncateOutput(content: string, maxLines= MAX_OUTPUT_LINES): Promise<string> {
    const lines = content.split('\n');
    if (lines.length <= maxLines) {
        return content;
    }
    const kept = lines.slice(-maxLines).join('\n');
    const tmpFile = path.join(os.tmpdir(), `nanopi-output-${process.pid}-${truncateCounter++}.txt`);
    await fs.writeFile(tmpFile, content, 'utf-8');
    return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`
}

/** read_file：返回文件内容（截取尾部防止超大输出） */
const readFile: AgentTool = {
    name: 'read_file',
    description: '读取文件内容。参数：path（文件路径）。大文件截取最后 200 行。',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径'
            }
        },
        required: ['path']
    },
    execute: async (args) => {
        const { path: filePath } = args as { path: string };
        const content = await fs.readFile(filePath, 'utf-8');
        return await truncateOutput(content, MAX_OUTPUT_LINES);
    },
}

const writeFile: AgentTool = {
    name: 'write_file',
    description: '写入文件（覆盖）。参数：path（路径）、content（内容）',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径'
            },
            content: {
                type: 'string',
                description: '文件内容'
            }
        },
        required: ['path', 'content']
    },
    execute: async (args) => {
        const { path: filePath, content } = args as { path: string; content: string };
        await fs.mkdir(path.dirname(filePath) || '.', { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return `wrote ${filePath} (${content.length} chars)`
    },
}

const edit: AgentTool = {
    name: 'edit',
    description: '编辑文件内容。参数：path（文件路径）、content（新内容）',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径'
            },
            old_string: {
                type: 'string',
                description: '要替换的旧字符串'
            },
            new_string: {
                type: 'string',
                description: '新的字符串'
            }
        },
        required: ['path', 'old_string', 'new_string'],
    },
    execute: async (args) => {
        const { path: filePath, old_string, new_string } = args as { path: string; old_string: string; new_string: string }
        const context = await fs.readFile(filePath, 'utf-8');
        const count = context.split(old_string).length - 1;
        if (count === 0) {
            throw new Error(`未找到要替换的字符串 "${old_string}"`);
        }
        if (count > 1) {
            throw new Error(`要替换的字符串 "${old_string}" 出现了 ${count} 次，请确保只出现一次`);
        }
        const newContent = context.replace(old_string, new_string);
        await fs.writeFile(filePath, newContent, 'utf-8');
        return `edited ${filePath} (${context.length} -> ${newContent.length} chars)`
    },
}


const runBash: AgentTool = {
    name: 'run_bash',
    description: '在本地执行 bash 命令。参数：command（命令字符串）。输出超过 200 行时截取尾部并提示完整输出文件路径。',
    parameters: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: '要执行的 bash 命令'
            }
        },
        required: ['command']
    },
    execute: async (args, signal) => {
        const { command } = args as { command: string };
        try {
            const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024, timeout: 30000, signal });
            const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
            return await truncateOutput(output);
        } catch (e: unknown) {
            if (signal?.aborted) {
                return 'aborted';
            }
            const err = e as NodeJS.ErrnoException & { code?: number; stderr?: string; stdout?: string };
            return `command failed: ${err.message}\ncode: ${err.code}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`;   
        }
    },
}

export function buildinTools(): AgentTool[] {
    return [readFile, writeFile, edit, runBash];
}   
