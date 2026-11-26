/*
 * Copyright 2026 The backstage-plugin-ai-chat Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { metricsServiceMock } from '@backstage/backend-test-utils/alpha';
import { BackstageMetrics } from './BackstageMetrics';

describe('BackstageMetrics', () => {
  it('creates the instruments on the metrics service, with the buckets as advice', () => {
    const service = metricsServiceMock.mock();
    const metrics = new BackstageMetrics(service);

    const counter = metrics.counter('ai_chat.tool.calls', {
      description: 'd',
      unit: '{call}',
    });
    const histogram = metrics.histogram('ai_chat.tool.duration', {
      description: 'd',
      unit: 's',
      buckets: [0.1, 1],
    });
    counter.add(1, { tool: 'a' });
    histogram.record(0.5, { tool: 'a' });

    expect(service.createCounter).toHaveBeenCalledWith('ai_chat.tool.calls', {
      description: 'd',
      unit: '{call}',
    });
    expect(service.createHistogram).toHaveBeenCalledWith(
      'ai_chat.tool.duration',
      {
        description: 'd',
        unit: 's',
        advice: { explicitBucketBoundaries: [0.1, 1] },
      },
    );
    const made = (service.createCounter as jest.Mock).mock.results[0].value;
    expect(made.add).toHaveBeenCalledWith(1, { tool: 'a' });
    const hist = (service.createHistogram as jest.Mock).mock.results[0].value;
    expect(hist.record).toHaveBeenCalledWith(0.5, { tool: 'a' });
  });
});
