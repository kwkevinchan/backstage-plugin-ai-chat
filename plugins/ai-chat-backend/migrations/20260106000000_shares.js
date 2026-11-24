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
 * A read-only share of a session (SH-01). `subject_ref` is `user:…` or
 * `group:…`. There is no role and no write permission: a share never grants
 * more than reading. `up_to_seq` null means the share keeps updating.
 * `outputs_up_to_seq` null means every tool output in that range is visible,
 * and 0 means none of them are. `revoked_at` set means the share is cancelled.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('shares', table => {
    table.comment('Read-only shares of a session');
    table.string('id', 64).notNullable().primary();
    table
      .string('session_id', 64)
      .notNullable()
      .references('id')
      .inTable('sessions')
      .onDelete('CASCADE');
    table.string('subject_ref', 255).notNullable().index();
    table
      .integer('up_to_seq')
      .nullable()
      .comment('Null means the share keeps updating');
    table
      .integer('outputs_up_to_seq')
      .nullable()
      .comment('Null means every tool output in range; 0 means none');
    table.string('expires_at', 32).nullable();
    table.string('created_by', 255).notNullable();
    table.string('created_at', 32).notNullable();
    table.string('revoked_at', 32).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('shares');
};
