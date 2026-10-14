import { validateEndpoint } from '../adapters/httpPoller.js';

export function validEndpointText(url) {
  if (!url) return 'กรุณาระบุ URL';
  const v = validateEndpoint(url);
  return v.ok ? null : v.error;
}
