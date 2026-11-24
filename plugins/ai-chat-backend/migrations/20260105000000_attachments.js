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
 * The images of the messages (D-27). The bytes are in the table, behind the
 * `AttachmentStore` port. `used_seq` is the `seq` of the first message that
 * uses the image, `reserved_by` the id of the queued message that holds it.
 * An image with both empty, stored more than 24 hours ago, is deleted.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('attachments', table => {
    table.comment('Images of the messages of a session');
    table.string('id', 64).primary();
    table
      .string('session_id', 64)
      .notNullable()
      .references('id')
      .inTable('sessions')
      .onDelete('CASCADE')
      .index();
    table.string('owner_ref', 255).notNullable();
    table.string('media_type', 32).notNullable();
    table.integer('size').notNullable();
    table.string('sha256', 64).notNullable();
    table.string('name', 255).notNullable();
    table.binary('bytes').notNullable();
    table.string('created_at', 32).notNullable().index();
    table
      .integer('used_seq')
      .nullable()
      .comment('The seq of the first user message that uses the image');
    table
      .string('reserved_by', 64)
      .nullable()
      .comment('The id of the queued message that holds the image');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('attachments');
};
