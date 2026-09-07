import { stream, buildAssistantMessage, buildToolResultMessage, type Model, type Context } from './llm.js'

export type AgentTool = {
    name: string
    description: string
    parameters: object
    execute: (args: unknown, signal?: AbortSignal) => Promise<string>
}

export type AgentEvent = 
    | { type: 'assistant_text'; delta: string }
    | { type: 'tool_call'; id: string; name: string; args: unknown }
    | { type: 'tool_result'; id: string; name: string; result: string }
    | { type: 'turn_end'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted'}

const COMPACT_THRESHOLD = 50
const KEEP_RECENT = 20


/**
 * Compacts the context by summarizing older messages if the threshold is exceeded
 */
async function compactContext(model: Model, context: Context, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return;
    }

    if (context.message.length < COMPACT_THRESHOLD) {
        return;
    }

    // Implementation for compacting context goes here

    const oldMessage = context.message.slice(0, context.message.length - KEEP_RECENT);
    const recentMessage = context.message.slice(context.message.length - KEEP_RECENT);

    const conversationText = oldMessage.map(msg => {
        `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`
    }).join('\n');

    const summaryContext: Context = {
        systemPrompt: 'Summarize the following conversation in a concise manner:',
        message: [
            { role: 'user', content: conversationText }
        ]
    };

    let summary = '';
    let failed = false;

    for await (const ev of stream(model, summaryContext, { signal })) {
        if (ev.type === 'text_delta') {
            summary += ev.delta;
        } else if (ev.type === 'error' || ev.type === 'done' && ev.stopReason === 'aborted') {
            failed = true;
            break;
        }
    }

    if (failed || !summary) {
        // If summarization failed, we can choose to keep the old messages or handle it differently
        return;
    }

    // Replace old messages with the summary
    context.message = [
        { role: 'assistant', content: summary },
        ...recentMessage
    ];
}



export async function* runAgent(
    model: Model,
    context: Context,
    tools: AgentTool[],
    signal?: AbortSignal
): AsyncGenerator<AgentEvent> {

    const toolMap = new Map(tools.map(tool => [tool.name, tool]));
    const toolDefs = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
    }));

    while (true) {

        let text = '';
        let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn';
        const toolCalls: { id: string; name: string; args: unknown}[] = [];

        for await (const ev of stream(model, context, {tools: toolDefs, signal})){
            if (ev.type === 'text_delta') {
                text += ev.delta;
                yield { type: 'assistant_text', delta: ev.delta };
            } else if (ev.type === 'tool_call') {
                toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
                yield { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args };
            } else if (ev.type === 'done') {
                stopReason = ev.stopReason;

                if (ev.stopReason === 'aborted') {
                    context.message.push(buildAssistantMessage(text, []));
                    yield { type: 'turn_end', stopReason: 'aborted' };
                    return;
                }
                
            } else if (ev.type === 'error') {
                context.message.push(buildAssistantMessage(text, []));
                yield { type: 'assistant_text', delta: 'Error occurred while processing the request.' };
                yield { type: 'turn_end', stopReason: 'aborted' };
                return;
            }
        }

        context.message.push(buildAssistantMessage(text, toolCalls));

        const reason = stopReason === 'tool_use' ? 'end_turn' : stopReason ;
        if (toolCalls.length === 0) {
            yield { type: 'turn_end', stopReason: reason };
            return;
        }

        const results: { tool_use_id: string; context: string}[] = [];

        for (const toolCall of toolCalls) {
            const tool = toolMap.get(toolCall.name);
            let result: string;
            if (!tool) {
                result = `Error: tool "${toolCall.name}" not found`;
            } else {
                try {
                    result = await tool.execute(toolCall.args, signal);
                } catch (error) {
                    result = `Error: tool "${toolCall.name}" execution failed: ${(error as Error).message}`;
                }
            }
            results.push({ tool_use_id: toolCall.id, context: result });
            yield { type: 'tool_result', id: toolCall.id, name: toolCall.name, result };
            if (signal?.aborted) {
                break;
            }
        }

        for (const tc of toolCalls.slice(0, results.length)) {
            results.push({ tool_use_id: tc.id, context: `Error: tool "${tc.name}" execution was aborted` });
            yield { type: 'tool_result', id: tc.id, name: tc.name, result: `Error: tool "${tc.name}" execution was aborted` };
        }

        context.message.push(buildToolResultMessage(results));

    }

}