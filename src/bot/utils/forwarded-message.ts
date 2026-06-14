import { Message } from 'grammy/types';

export function isForwardedMessage(msg: Message): boolean {
  const legacyFrom = (msg as { forward_from?: { id: number } }).forward_from;
  return !!(msg.forward_origin || legacyFrom);
}