const MAX_RECENT_EVENTS = 200;

const state = {
  events: [],
};

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function recordTokenUsage(event) {
  const normalized = {
    timestamp: new Date().toISOString(),
    task: String(event?.task || "unclassified"),
    operation: String(event?.operation || "unknown"),
    provider: String(event?.provider || "unknown"),
    model: String(event?.model || "unknown"),
    inputTokens: toNumber(event?.inputTokens),
    outputTokens: toNumber(event?.outputTokens),
    totalTokens: toNumber(event?.totalTokens),
    meta: event?.meta && typeof event.meta === "object" ? event.meta : {},
  };

  if (!normalized.totalTokens) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }

  state.events.push(normalized);
  if (state.events.length > MAX_RECENT_EVENTS) {
    state.events.splice(0, state.events.length - MAX_RECENT_EVENTS);
  }

  return normalized;
}

function buildSnapshot() {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    eventCount: state.events.length,
  };

  const taskMap = new Map();

  for (const event of state.events) {
    totals.inputTokens += event.inputTokens;
    totals.outputTokens += event.outputTokens;
    totals.totalTokens += event.totalTokens;

    if (!taskMap.has(event.task)) {
      taskMap.set(event.task, {
        task: event.task,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        eventCount: 0,
        operations: new Map(),
      });
    }

    const taskEntry = taskMap.get(event.task);
    taskEntry.inputTokens += event.inputTokens;
    taskEntry.outputTokens += event.outputTokens;
    taskEntry.totalTokens += event.totalTokens;
    taskEntry.eventCount += 1;

    const opKey = event.operation;
    if (!taskEntry.operations.has(opKey)) {
      taskEntry.operations.set(opKey, {
        operation: opKey,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        eventCount: 0,
      });
    }

    const opEntry = taskEntry.operations.get(opKey);
    opEntry.inputTokens += event.inputTokens;
    opEntry.outputTokens += event.outputTokens;
    opEntry.totalTokens += event.totalTokens;
    opEntry.eventCount += 1;
  }

  const tasks = [...taskMap.values()].map((entry) => ({
    task: entry.task,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    eventCount: entry.eventCount,
    operations: [...entry.operations.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  }));

  tasks.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    tasks,
    recentEvents: [...state.events].slice(-20).reverse(),
  };
}

function clearTokenUsage() {
  state.events = [];
}

module.exports = {
  recordTokenUsage,
  buildSnapshot,
  clearTokenUsage,
};
