import { createEventBus, type ExtensionAPI, type ExtensionEvent } from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noExplicitAny: Event overloads are intentionally erased at this reusable test boundary.
type Handler = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: Tests recover each registered tool's concrete schema through its public execute seam.
type RegisteredTool = any;
// biome-ignore lint/suspicious/noExplicitAny: Command contexts are intentionally partial public-seam fakes in individual tests.
type CommandDefinition = any;
// biome-ignore lint/suspicious/noExplicitAny: Tests inspect protocol-specific payloads after public event-bus routing.
type EventPayload = any;
type SentMessage = Parameters<ExtensionAPI["sendMessage"]>;

/** Minimal reusable ExtensionAPI host for registration and lifecycle boundary tests. */
export function createExtensionApiHarness() {
    const tools = new Map<string, RegisteredTool>();
    const commands = new Map<string, CommandDefinition>();
    const handlers = new Map<ExtensionEvent["type"], Handler[]>();
    const messages: SentMessage[] = [];
    const emitted: Array<{ channel: string; payload: EventPayload }> = [];
    const eventHandlers = new Map<string, Set<(payload: EventPayload) => void>>();
    const eventBus = createEventBus();
    const emit = eventBus.emit.bind(eventBus);
    eventBus.emit = (channel, payload) => {
        emitted.push({ channel, payload });
        emit(channel, payload);
    };
    const listen = eventBus.on.bind(eventBus);
    eventBus.on = (channel, handler) => {
        const listeners = eventHandlers.get(channel) ?? new Set();
        listeners.add(handler);
        eventHandlers.set(channel, listeners);
        const unsubscribe = listen(channel, handler);
        return () => {
            listeners.delete(handler);
            unsubscribe();
        };
    };

    const on = ((event: ExtensionEvent["type"], handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }) as ExtensionAPI["on"];
    const registerTool: ExtensionAPI["registerTool"] = (tool) => tools.set(tool.name, tool);

    // ExtensionAPI is intentionally broad. The proxy fails loudly if a test exercises an
    // unimplemented host capability instead of silently supplying an unrealistic fake.
    const api = new Proxy(
        {
            events: eventBus,
            on,
            registerTool,
            registerCommand(name: string, command: CommandDefinition) {
                commands.set(name, command);
            },
            sendMessage(...args: SentMessage) {
                messages.push(args);
            },
        } as unknown as ExtensionAPI,
        {
            get(target, property, receiver) {
                if (property in target) return Reflect.get(target, property, receiver);
                // Runtime probes must not be mistaken for unimplemented host capabilities.
                if (typeof property === "symbol" || property === "then") return undefined;
                throw new Error(`Fake ExtensionAPI does not implement ${String(property)}`);
            },
        },
    ) as ExtensionAPI;

    return {
        api,
        tools,
        commands,
        messages,
        emitted,
        eventHandlers,
        events: eventBus,
        listenerCount(channel: string) {
            return eventHandlers.get(channel)?.size ?? 0;
        },
        tool(name: string): RegisteredTool {
            const tool = tools.get(name);
            if (!tool) throw new Error(`Missing ${name} tool`);
            return tool;
        },
        command(name: string) {
            const command = commands.get(name);
            if (!command) throw new Error(`Missing ${name} command`);
            return command;
        },
        handlers,
        handler(name: ExtensionEvent["type"]): Handler {
            const handler = handlers.get(name)?.[0];
            if (!handler) throw new Error(`Missing ${name} handler`);
            return handler;
        },
    };
}

export type ExtensionApiHarness = ReturnType<typeof createExtensionApiHarness>;
