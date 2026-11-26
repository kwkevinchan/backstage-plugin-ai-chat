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

/** The attributes of one measurement: low-cardinality labels only. */
export type MetricAttributes = Readonly<
  Record<string, string | number | boolean>
>;

/** The description, the unit and, for a histogram, the bucket boundaries. */
export type MetricOptions = {
  description: string;
  unit: string;
  buckets?: readonly number[];
};

export interface MetricCounter {
  add(value: number, attributes: MetricAttributes): void;
}

export interface MetricHistogram {
  record(value: number, attributes: MetricAttributes): void;
}

/** Where the host sends its metrics (O-01). */
export interface Metrics {
  counter(name: string, options: MetricOptions): MetricCounter;
  histogram(name: string, options: MetricOptions): MetricHistogram;
}

/** Metrics that go nowhere: for a host with no metrics service. */
export class NoopMetrics implements Metrics {
  counter(_name: string, _options: MetricOptions): MetricCounter {
    return { add: () => {} };
  }

  histogram(_name: string, _options: MetricOptions): MetricHistogram {
    return { record: () => {} };
  }
}
