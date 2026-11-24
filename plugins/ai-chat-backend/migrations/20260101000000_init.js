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
 * Times are ISO 8601 strings written by the plugin, so that every database
 * returns and orders them the same way. JSON values are stored as text.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('conversations', table => {
    table.comment('Conversations of the AI chat, one owner each');
    table.string('id', 64).primary();
    table.string('user_entity_ref', 255).notNullable().index();
    table.string('title', 255).notNullable();
    table.string('created_at', 32).notNullable();
    table.string('updated_at', 32).notNullable();
  });

  await knex.schema.createTable('messages', table => {
    table.comment('Messages of a conversation, in the order of seq');
    table.string('id', 64).primary();
    table
      .string('conversation_id', 64)
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE');
    table.integer('seq').notNullable();
    table.string('role', 16).notNullable();
    table.text('content').notNullable();
    table
      .string('tool_call_id', 255)
      .nullable()
      .comment('For the tool role: the call ID that the model gave');
    table.string('created_at', 32).notNullable();
    table.unique(['conversation_id', 'seq']);
  });

  await knex.schema.createTable('tool_calls', table => {
    table.comment('Calls of actions that the model asked for');
    table.string('id', 64).primary();
    table
      .string('conversation_id', 64)
      .notNullable()
      .references('id')
      .inTable('conversations')
      .onDelete('CASCADE')
      .index();
    table
      .string('message_id', 64)
      .notNullable()
      .references('id')
      .inTable('messages')
      .onDelete('CASCADE');
    table
      .integer('position')
      .notNullable()
      .comment('Place among the calls of one assistant message');
    table
      .string('llm_call_id', 255)
      .notNullable()
      .comment('The call ID that the model gave');
    table.string('tool_name', 255).notNullable();
    table.string('action_id', 255).notNullable();
    table.string('action_title', 255).notNullable();
    table.text('action_description').notNullable();
    table.text('input').notNullable().comment('JSON, the exact input to run');
    table
      .text('attributes')
      .notNullable()
      .comment(
        'JSON: readOnly, destructive, idempotent at the time of the call',
      );
    table.string('status', 24).notNullable();
    table.text('output').nullable().comment('JSON, cut to a limit');
    table.text('error').nullable();
    table.string('decided_by', 255).nullable();
    table.string('decided_at', 32).nullable();
    table.string('created_at', 32).notNullable();
    table.string('updated_at', 32).notNullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('tool_calls');
  await knex.schema.dropTable('messages');
  await knex.schema.dropTable('conversations');
};
