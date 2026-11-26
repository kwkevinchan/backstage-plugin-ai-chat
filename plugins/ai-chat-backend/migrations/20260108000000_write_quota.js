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
 * The changes each user made in each minute, that all backends share for the
 * quota of changes (T-10). `window_start` is the start of the minute as an ISO
 * time; a row is one minute of one user.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('write_quota_windows', table => {
    table.comment('Changes per user and minute, for the quota of changes');
    table.string('user_ref', 255).notNullable();
    table.string('window_start', 32).notNullable();
    table.integer('writes').notNullable();
    table.primary(['user_ref', 'window_start']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('write_quota_windows');
};
