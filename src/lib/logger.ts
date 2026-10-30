type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): Level {
  const raw = (process.env.LOG_LEVEL || 'info') as Level;
  return raw in order ? raw : 'info';
}

function write(level: Level, event: string, fields?: Record<string, unknown>) {
  if (order[level] < order[configuredLevel()]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields || {})
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields)
};
