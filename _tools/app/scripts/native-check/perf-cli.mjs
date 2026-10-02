export const usage = `Screenshot: node run.mjs <steps.json> <out-dir>
Performance: node run.mjs --perf <scenarios.json> <out-dir> [--baseline <result.json>]
Offline: node run.mjs --perf <scenarios.json> <out-dir> --sample <recording.json> [--baseline <result.json>]
Validate only: node run.mjs --perf <scenarios.json> <out-dir> --dry-run`;
export function parseArgs(args) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--perf', '--dry-run', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--baseline', '--sample'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing value for ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (options.help) return options;
  if (positional.length !== 2) throw new Error(usage);
  if (!options.perf && (options.sample || options.baseline || options['dry-run'])) throw new Error('report options require --perf');
  return { ...options, stepsFile: positional[0], outDir: positional[1] };
}
export function validateScenarios(config) {
  if (config.version !== 1 || !Array.isArray(config.scenarios) || !config.scenarios.length || !(config.frameBudgetMs > 0) || !Number.isFinite(config.frameBudgetMs)) throw new Error('invalid scenario schema');
  const ids = new Set();
  const operations = new Set(['click', 'clickText', 'dblclick', 'key', 'type', 'scroll', 'settle', 'wait', 'hidden', 'visible', 'assert', 'waitFor']);
  for (const scenario of config.scenarios) {
    if (!/^[a-z0-9-]+$/.test(scenario.id) || ids.has(scenario.id) || !scenario.steps?.length) throw new Error('scenario needs unique id and steps');
    if (scenario.id === 'startup' && (ids.size || scenario.setup?.length)) throw new Error('startup must be first and have no unmeasured setup');
    ids.add(scenario.id);
    for (const step of [...(scenario.setup ?? []), ...scenario.steps]) {
      const keys = Object.keys(step);
      if (keys.length !== 1 || !operations.has(keys[0])) throw new Error(`invalid step in ${scenario.id}`);
      const op = keys[0], value = step[op];
      if (['click', 'dblclick', 'key', 'waitFor', 'assert'].includes(op) && (typeof value !== 'string' || !value)) throw new Error(`invalid ${op}`);
      if (op === 'wait' && (!Number.isFinite(value) || value < 0 || value > 120000)) throw new Error('invalid wait');
      if (['hidden', 'visible'].includes(op) && value !== true) throw new Error(`invalid ${op}`);
      if (op === 'clickText' && (!value?.selector || typeof value.text !== 'string')) throw new Error('invalid clickText');
      if (op === 'type' && (!value?.selector || typeof value.text !== 'string' || (value.intervalMs !== undefined && (!Number.isFinite(value.intervalMs) || value.intervalMs < 0 || value.intervalMs > 1000)))) throw new Error('invalid type');
      if (op === 'settle' && !value?.selector) throw new Error('invalid settle');
      if (op === 'scroll' && (!value?.selector || !(value.durationMs > 0 && value.durationMs <= 20000) || !Number.isFinite(value.pixels))) throw new Error('invalid scroll');
    }
  }
  return config;
}
