/** MCP tool definitions exposed to Claude. Execution happens in the daemon (src/daemon/tools.ts). */

const chatId = { type: 'string', description: 'Target chat_id from the inbound <channel> tag. Optional: defaults to the chat/topic this session talks in.' }
const threadId = { type: 'string', description: 'Forum topic thread id. Optional: defaults to the thread of the inbound message / this session\'s topic.' }

const optionsSchema = {
  type: 'array',
  description: 'Answer options (1–10). Each is a string or { label (≤40 chars), value?, style?: "primary"|"success"|"danger" }.',
  items: {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'string' }, style: { type: 'string', enum: ['primary', 'success', 'danger'] } },
        required: ['label'],
      },
    ],
  },
}

export const TOOLS = [
  {
    name: 'reply',
    description: 'Reply on Telegram. Pass chat_id from the inbound message. Optionally reply_to (message_id) to quote-thread, files (absolute paths) to attach, buttons to offer tap-to-answer options.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: chatId,
        message_thread_id: threadId,
        text: { type: 'string' },
        reply_to: { type: 'string', description: 'Message ID to thread under. Use message_id from the inbound <channel> block only when replying to an earlier message.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths. Images go as photos, other types as documents. Max 50MB each.' },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2', 'rich'],
          description: "'text' (default, plain), 'markdownv2' (caller escapes per MarkdownV2), 'rich' (Telegram rich message from ordinary Markdown: **bold**, lists, tables, code; falls back to text if unsupported).",
        },
        buttons: optionsSchema,
      },
      required: ['text'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user to choose: posts the question with inline buttons. Use this instead of listing options in text whenever you offer choices or need a yes/no confirmation. The answer arrives later as a <channel> event with event="answer" and question_id.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: chatId,
        message_thread_id: threadId,
        text: { type: 'string', description: 'The question.' },
        options: optionsSchema,
        multi: { type: 'boolean', description: 'Allow picking several options (adds a "Done" button).' },
        allow_text: { type: 'boolean', description: 'The user may also answer by text reply (default true).' },
        timeout_min: { type: 'number', description: 'Disable the buttons after this many minutes.' },
      },
      required: ['text', 'options'],
    },
  },
  {
    name: 'notify',
    description: 'Send a message without an inbound message to answer — e.g. a long task finished, a build failed, a reminder. Goes to this session\'s topic by default (with a push), or to another topic by name.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        topic: { type: 'string', description: 'Topic name or thread id in the connected group. Default: this session\'s topic.' },
        silent: { type: 'boolean', description: 'Deliver without a notification sound.' },
        files: { type: 'array', items: { type: 'string' } },
        buttons: optionsSchema,
      },
      required: ['text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc).',
    inputSchema: {
      type: 'object',
      properties: { chat_id: chatId, message_id: { type: 'string' }, emoji: { type: 'string' } },
      required: ['message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message the bot previously sent. Edits don\'t trigger push notifications — send a new reply when a long task completes.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: chatId,
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: { type: 'string', enum: ['text', 'markdownv2'] },
      },
      required: ['message_id', 'text'],
    },
  },
  {
    name: 'download_attachment',
    description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' } },
      required: ['file_id'],
    },
  },
  {
    name: 'get_history',
    description: 'Recent messages of this chat/topic from the local history store (survives restarts). Use when the user refers to earlier conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: chatId,
        message_thread_id: threadId,
        topic: { type: 'string', description: 'Another topic by name.' },
        limit: { type: 'number', description: 'Default 30, max 200.' },
        before_message_id: { type: 'number', description: 'Page backwards.' },
      },
    },
  },
  {
    name: 'search_messages',
    description: 'Full-text search over stored Telegram history of this chat/topic (or all chats).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        chat_id: chatId,
        message_thread_id: threadId,
        topic: { type: 'string' },
        all_chats: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_message',
    description: 'One stored message with all details (reply, quote, forward origin, attachment).',
    inputSchema: {
      type: 'object',
      properties: { chat_id: chatId, message_id: { type: 'number' } },
      required: ['message_id'],
    },
  },
  {
    name: 'save_memory',
    description: 'Overwrite the persistent memory note of this chat/topic. It is shown to future sessions when they connect. Keep it a concise summary: goals, decisions, agreements, open tasks.',
    inputSchema: {
      type: 'object',
      properties: { chat_id: chatId, message_thread_id: threadId, text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'read_memory',
    description: 'Read the persistent memory note of this chat/topic.',
    inputSchema: { type: 'object', properties: { chat_id: chatId, message_thread_id: threadId } },
  },
  {
    name: 'list_topics',
    description: 'List forum topics in the connected group with their projects and live sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_topic',
    description: 'Create an extra forum topic in the connected group.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'rename_topic',
    description: 'Rename a forum topic.',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'number' }, name: { type: 'string' } }, required: ['thread_id', 'name'] },
  },
  {
    name: 'archive_topic',
    description: 'Archive a forum topic (renamed with 🗄, unbound from its session).',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'number' } }, required: ['thread_id'] },
  },
  {
    name: 'delete_topic',
    description: 'Request deletion of a forum topic with all its messages. The user must confirm with a button; nothing is deleted until then.',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'number' } }, required: ['thread_id'] },
  },
]
