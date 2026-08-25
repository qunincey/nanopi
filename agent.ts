export async function* runAgent(
    model: Model,
    context: Context,
    tools: AgentTool[],
    signal?: AbortSignal
): AsyncGenerator<AgentEvent> {

    while (true) {

        let text = '';

        const toolCalls: { id: string; name: string; args: unknown}[] = [];

        for await (const ev of stream(model, context, {tools: toolDefs, signal})){

        }

        context.message.push(buildAssistantMessage(text, toolCalls));

        if (toolCalls.length === 0) {
            return;
        }

        const results: { tool_use_id: string; context: string}[] = [];

        for (const toolCall of toolCalls) {
        }

        context.message.push(buildToolResultMessage(results));

    }

}