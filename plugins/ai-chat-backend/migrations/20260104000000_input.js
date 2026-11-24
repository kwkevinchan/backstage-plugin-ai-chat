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
 * The tables of the input phase: `runs.read_up_to_seq`, the largest sequence
 * number the model had read when its last call began (the run does not end
 * while a message was inserted after it), and `queued_messages`, the messages
 * that wait for the run of their session to end. `attachment_ids` is the JSON
 * array of the images of a message; it is empty until messages carry images.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('runs', table => {
    table
      .integer('read_up_to_seq')
      .notNullable()
      .defaultTo(0)
      .comment('The largest seq the last model call read when it began');
  });

  await knex.schema.createTable('queued_messages', table => {
    table.comment('Messages that wait for the run of their session to end');
    table.string('id', 64).primary();
    table
      .string('session_id', 64)
      .notNullable()
      .references('id')
      .inTable('sessions')
      .onDelete('CASCADE');
    table
      .integer('position')
      .notNullable()
      .comment('From 1; no unique index, a reorder holds equal values');
    table.text('text').notNullable();
    table
      .text('attachment_ids')
      .notNullable()
      .defaultTo('[]')
      .comment('JSON array of attachment ids');
    table.text('page').nullable().comment('JSON');
    table.string('created_at', 32).notNullable();
    table.string('updated_at', 32).notNullable();
    table.index(['session_id', 'position']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('queued_messages');
  await knex.schema.alterTable('runs', table => {
    table.dropColumn('read_up_to_seq');
  });
};
