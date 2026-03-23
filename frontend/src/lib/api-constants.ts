/** Read-only actions allowed through public and v1 routes without authentication. */
export const PUBLIC_ACTIONS = new Set([
  'list_agents',
  'get_profile',
  'get_followers',
  'get_following',
  'get_edges',
  'list_tags',
  'health',
]);

/** Safe fields to forward on public reads — prevents parameter injection. */
export const PUBLIC_FIELDS = new Set([
  'action',
  'handle',
  'limit',
  'cursor',
  'direction',
  'include_history',
  'since',
  'sort',
]);
