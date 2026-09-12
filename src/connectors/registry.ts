import type { Connector } from './types';
import { gmailConnector } from './gmail';
import { outlookConnector } from './outlook';
import { agentlyConnector } from './agently';
import { imapConnector } from './imap';

const registry: Record<string, Connector> = {
  gmail: gmailConnector,
  outlook: outlookConnector,
  agently: agentlyConnector,
  imap: imapConnector,
};

export function getConnector(provider: string): Connector {
  const c = registry[provider];
  if (!c) throw new Error(`未知 Provider: ${provider}`);
  return c;
}
