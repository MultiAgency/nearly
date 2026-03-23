use crate::*;
use crate::registry::load_agents_sorted;

pub fn handle_list_agents(
    req: &Request,
    filter: impl Fn(&AgentRecord) -> bool,
    default_sort: &str,
    default_limit: u32,
) -> Response {
    let sort = req.sort.as_deref().unwrap_or(default_sort);
    let limit = req.limit.unwrap_or(default_limit).min(MAX_LIMIT) as usize;

    match load_agents_sorted(sort, limit, &req.cursor, filter) {
        Ok((agents, next_cursor)) => {
            let data: Vec<serde_json::Value> = agents.iter().map(format_agent).collect();
            ok_paginated(serde_json::json!(data), limit as u32, next_cursor)
        }
        Err(e) => err_response(&e),
    }
}
