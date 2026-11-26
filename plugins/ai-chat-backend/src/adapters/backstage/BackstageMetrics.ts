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

import type { MetricsService } from '@backstage/backend-plugin-api/alpha';
import type {
  MetricCounter,
  MetricHistogram,
  MetricOptions,
  Metrics,
} from '../../application/ports';

/**
 * The metrics of the host on the metrics service of Backstage, which is
 * OpenTelemetry. Without an OpenTelemetry SDK in the backend, the meter does
 * nothing.
 */
export class BackstageMetrics implements Metrics {
  constructor(private readonly metrics: MetricsService) {}

  counter(name: string, options: MetricOptions): MetricCounter {
    const counter = this.metrics.createCounter(name, {
      description: options.description,
      unit: options.unit,
    });
    return { add: (value, attributes) => counter.add(value, attributes) };
  }

  histogram(name: string, options: MetricOptions): MetricHistogram {
    const histogram = this.metrics.createHistogram(name, {
      description: options.description,
      unit: options.unit,
      ...(options.buckets && {
        advice: { explicitBucketBoundaries: [...options.buckets] },
      }),
    });
    return {
      record: (value, attributes) => histogram.record(value, attributes),
    };
  }
}
