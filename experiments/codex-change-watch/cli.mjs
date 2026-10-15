import { readFile } from 'node:fs/promises';
import { evaluateObservation } from './watch.mjs';
import { demoWatch, observation, scenarios } from './scenarios.mjs';

try {
  const path = process.argv[2];
  if (path) {
    // The input is data only. No URL is fetched, no state is written.
    const input = JSON.parse(await readFile(path, 'utf8'));
    console.log(JSON.stringify(evaluateObservation(input.watch, input.state ?? null, input.observation), null, 2));
  } else {
    const first = evaluateObservation(demoWatch, null, observation(1));
    for (const scenario of scenarios) {
      const output = evaluateObservation({ ...demoWatch, ...scenario.watch }, first.nextState, observation(2, scenario.next));
      console.log(`${scenario.title} → ${output.decision} / ${output.shouldNotify ? '建议说明' : '不产生新消息'}：${output.summary}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid input');
  process.exitCode = 1;
}
