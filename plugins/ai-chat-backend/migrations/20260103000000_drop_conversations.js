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
 * Drops the tables of the first version of the plugin (conversations,
 * messages, tool_calls). The sessions of the log (`sessions`, `runs`,
 * `items`) replace them, and the old rows are not moved: the plugin has no
 * code that reads them any more.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // The tables that refer to another go first.
  await knex.schema.dropTableIfExists('tool_calls');
  await knex.schema.dropTableIfExists('messages');
  await knex.schema.dropTableIfExists('conversations');
};

/**
 * Creates the three tables again, empty: the rows that `up` dropped are gone.
 * The tables exist so that rolling back the migrations one by one reaches
 * `20260101000000_init`, which drops them.
 *
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await require('./20260101000000_init').up(knex);
};
