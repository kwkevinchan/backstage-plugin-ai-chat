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

// @ts-check

/**
 * The model calls of each minute, by model, that all backends share for the
 * rate limit (P-06). `window_start` is the start of the minute as an ISO
 * time; a row is one minute of one model.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('model_call_windows', table => {
    table.comment('Model calls per minute, for the rate limit of a model');
    table.string('model_id', 64).notNullable();
    table.string('window_start', 32).notNullable();
    table.integer('calls').notNullable();
    table.primary(['model_id', 'window_start']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('model_call_windows');
};
