export type Model = {
    apiKey: string
    model: string
    baseUrl?: string
    maxTokens?: number
}

export type ContentBlock = 
    | { type: 'text', text: string }
    | { type: 'tool_use', id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string }


export type Message = {
    role: 'user' | 'assistant'
    content: string | ContentBlock[]
}

export type Context = {
    systemPrompt?: string
    message: Message[]
}

export type StreamEvent = 
    | { type: 'text_delta'; delta: string }
    | { type: 'tool_call'; id: string; name: string; args: unknown }
    | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted'}
    | { type: 'error'; error: Error }

export type ToolDef = {
    name: string
    description: string
    parameters: object
}

export function contextToOpenAIMessages(context: Context): object[] {

    const messages: object[] = [];
    if (context.systemPrompt) {
        messages.push({ role: 'system', content: context.systemPrompt });
    }

    for (const msg of context.message) {
        if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
            continue;
        }

        const blocks = msg.content;

        if (msg.role === 'assistant') {
            const toolCalls: object[] = [];
            let text = '';
            for (const block of blocks) {
                if (block.type === 'text') {
                    text += block.text;
                } else if (block.type === 'tool_use') {
                    toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } })
                }
            }
            const content = text || (toolCalls.length ? null : '');
            messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined });
        } else {
            // user message 里的 tool_result block → OpenAI 要求独立的 role:tool 消息
            for (const b of blocks) {
                if (b.type === 'tool_result') {
                messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
                } else if (b.type === 'text') {
                messages.push({ role: 'user', content: b.text })
                }
            }
        }
    }

    return messages;
}

/** OpenAIChunk SSE chunk 的最小类型 */
type OpenAIChunk = {
    choices: Array<{
        delta?: {
            content?: string
            tool_call?: Array<{ index?: number; 
                id?: string;
                function?: {
                    name?: string; 
                    arguments?: string 
                }}>
        }
        finish_reason?: string
    }>
}

/** 解析一行 SSE data，累积 tool_call，返回 text_delta 和 stop_reason */
function handleSSELine(
    data: string,
    toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
) : { textDelta: string | null; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null } {

    let chunk: OpenAIChunk;

    try {
        chunk = JSON.parse(data) as OpenAIChunk;
    }
    catch (error) {
        console.error('Error parsing SSE line:', error);
        return { textDelta: null, stopReason: null };
    }

    const choice = chunk.choices[0];
    if (!choice.delta?.content) return { textDelta: null, stopReason: null };

    let textDelta: string | null = null;
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' | null = null;

    if (choice.delta?.content) {
        textDelta = choice.delta.content;
    }

    if (choice.delta?.tool_call) {
        for (const tc of choice.delta.tool_call) {
           
            const idx = tc.index ?? 0;
            if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsBuf: '' });
            }
            const entry = toolCallBuffers.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.argsBuf += tc.function.arguments;

        }
    }

    if (choice.finish_reason === 'tool_calls') {
        stopReason = 'tool_use';
    }else if (choice.finish_reason === 'length') {
        stopReason = 'max_tokens';
    }

    return { textDelta, stopReason };
}

/** 流结束：把累积的 tool_calls 按顺序发出 */
function flushToolCalls(
    toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>
): { id: string; name: string; args: unknown }[] {
    const calls: { id: string; name: string; args: unknown }[] = [];
    
    for (const [, tc] of [...toolCallBuffers].sort(([a], [b]) => a - b)) {
       let args: unknown;
       if (tc.argsBuf) {
            try {
                args = JSON.parse(tc.argsBuf);
            }
            catch {
                args = {}
            }
       }
       calls.push({ id: tc.id, name: tc.name, args });
    }
    return calls;
}

// ===== stream 函数 =====

/**
 * 调用 OpenAI Completions API（streaming），返回统一事件流。
 *
 * @param model    模型配置
 * @param context  对话上下文
 * @param opts     tools + abort signal
 */
export async function* stream(
    model: Model,
    context: Context,
    opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {

    const url = `${model.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`;
    const messages = contextToOpenAIMessages(context);

    const body: Record<string, unknown> = {
        model: model.model,
        messages,
        stream: true,
    };
    if (model.maxTokens) {
        body['max_tokens'] = model.maxTokens;
    }
    if (opts.tools?.length){
        body.tools = opts.tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        }));
    }

    // 发请求
    let response: Response;
    try {

        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${model.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: opts.signal
        });
    } catch (error) {
        if (opts.signal?.aborted) {
            yield { type: 'done', stopReason: 'aborted' };
            return;
        }
        yield { type: 'error', error: error as Error }; return;
    }

    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => 'unknown error');
        yield { type: 'error', error: new Error(`OpenAI API request failed: ${response.status} ${response.statusText}: ${text}`) };
        return;
    }

    // 逐行解析 SSE
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuf: string }>();

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let nlIndex: number;
            while ((nlIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nlIndex).trim();
                buffer = buffer.slice(nlIndex + 1);
                if (line.startsWith('data: ')) continue;

                const data = line.slice(6)
                if (data === '[DONE]') continue;

                const result = handleSSELine(data, toolCallBuffers);
                if (result.textDelta) {
                    yield { type: 'text_delta', delta: result.textDelta };
                }
                if (result.stopReason) {
                    stopReason = result.stopReason;
                }
            }   
        }
    } catch (error) {
        if (opts.signal?.aborted) {
            yield { type: 'done', stopReason: 'aborted' };
            return;
        }
        yield { type: 'error', error: error as Error }; return;
    }
}

export function buildAssistantMessage(
    text: string,
    toolCalls: { id: string; name: string; args: unknown }[]
): Message {
    const content: ContentBlock[] = [];
    if (text) {
        content.push({ type: 'text', text });
    }
    for (const tc of toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    }
    return { role: 'assistant', content };
}


export function buildToolResultMessage(
    results: { tool_use_id: string; context: string }[]
): Message {
    return {
        role: 'user',
        content: results.map(r => ({
            type: 'tool_result' as const,
            tool_use_id: r.tool_use_id,
            content: r.context
        }))
    };
}