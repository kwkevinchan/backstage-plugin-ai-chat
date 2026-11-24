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
 * The tables of the session log: sessions, runs and items. They live next to
 * the tables of the first version (conversations, messages, tool_calls),
 * which this migration does not touch.
 *
 * Times are ISO 8601 strings written by the plugin, so that every database
 * returns and orders them the same way. JSON values are stored as text.
 *
 * Both unique indexes below have a column that is null for most rows
 * (`runs.active_session_id`, `items.dedupe_key`). SQLite and PostgreSQL
 * both treat nulls as distinct in a unique index, so any number of rows with
 * a null do not conflict, and only equal values do. The tests of the
 * persistence adapters check this on both databases.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('sessions', table => {
    table.comment('Sessions of the AI chat, one owner each');
    table.string('id', 64).primary();
    table.string('owner_ref', 255).notNullable().index();
    table.string('agent_id', 64).notNullable();
    table.string('title', 255).nullable();
    table.string('entity_ref', 255).nullable().index();
    table
      .text('enabled_toolsets')
      .notNullable()
      .comment('JSON array of toolset ids');
    table
      .integer('next_seq')
      .notNullable()
      .defaultTo(1)
      .comment('The seq of the next item; grows with each appended item');
    table.string('forked_from_session', 64).nullable();
    table.integer('forked_from_seq').nullable();
    table.boolean('pinned').notNullable().defaultTo(false);
    table.string('archived_at', 32).nullable();
    table.string('created_at', 32).notNullable();
    table.string('updated_at', 32).notNullable();
    table.index(['owner_ref', 'updated_at']);
  });

  await knex.schema.createTable('runs', table => {
    table.comment('Runs of the agent loop, at most one active per session');
    table.string('id', 64).primary();
    table
      .string('session_id', 64)
      .notNullable()
      .references('id')
      .inTable('sessions')
      .onDelete('CASCADE')
      .index();
    table.string('parent_run_id', 64).nullable();
    table.string('status', 24).notNullable();
    table
      .string('active_session_id', 64)
      .nullable()
      .unique()
      .comment('The session id while the run is active, null after it ends');
    table.string('lease_owner', 64).nullable();
    table.string('lease_expires_at', 32).nullable().index();
    table.integer('steps_used').notNullable().defaultTo(0);
    table.integer('tool_calls_used').notNullable().defaultTo(0);
    table
      .double('elapsed_seconds')
      .notNullable()
      .defaultTo(0)
      .comment('Working time, without the time spent waiting for an approval');
    table.boolean('cancel_requested').notNullable().defaultTo(false);
    table.string('end_reason', 32).nullable();
    table.string('started_at', 32).notNullable();
    table.string('ended_at', 32).nullable();
  });

  await knex.schema.createTable('items', table => {
    table.comment('The log of a session: items in the order of seq');
    table
      .string('session_id', 64)
      .notNullable()
      .references('id')
      .inTable('sessions')
      .onDelete('CASCADE');
    table.integer('seq').notNullable();
    table.string('run_id', 64).nullable();
    table.string('kind', 24).notNullable();
    table.text('payload').notNullable().comment('JSON, the item without kind');
    table
      .string('dedupe_key', 96)
      .nullable()
      .comment('Kind and call id, for the items written once per call');
    table.string('created_at', 32).notNullable();
    table.primary(['session_id', 'seq']);
    table.unique(['session_id', 'dedupe_key']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('items');
  await knex.schema.dropTable('runs');
  await knex.schema.dropTable('sessions');
};
