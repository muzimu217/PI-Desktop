//! Read-only usage statistics aggregated from the durable `turns` table.
//!
//! The summary is the only consumer of the range scan; the heatmap reuses the
//! same pass over a 365-day window. A small TTL cache keyed by
//! (range, project, timezone offset, metric version, last turn end) keeps tab
//! switches SQL-free while new turns still invalidate naturally.

use crate::db::Database;
use anyhow::Result;
use chrono::Local;
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const METRIC_VERSION: u32 = 1;
const CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const HEATMAP_DAYS: i64 = 365;
const LARGE_CONTEXT_TOKENS: i64 = 100_000;
const PROJECT_TOP_N: usize = 8;

#[derive(Default)]
pub struct SummaryCache(std::sync::Mutex<Option<(u64, i64, Value)>>);

impl SummaryCache {
    pub fn get(&self, key: u64, now_ms: i64) -> Option<Value> {
        let guard = self.0.lock().ok()?;
        guard
            .as_ref()
            .filter(|(k, at, _)| *k == key && now_ms - *at < CACHE_TTL_MS)
            .map(|(_, _, v)| v.clone())
    }

    pub fn put(&self, key: u64, now_ms: i64, value: Value) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some((key, now_ms, value));
        }
    }
}

pub fn cache_key(db: &Database, range_days: i64, project_id: Option<i64>) -> Result<u64> {
    let last_turn: Option<i64> =
        db.conn()
            .query_row("SELECT MAX(ended_at) FROM turns", [], |row| row.get(0))?;
    let tz_minutes = Local::now().offset().local_minus_utc() / 60;
    let digest = Sha256::digest(
        format!("v{METRIC_VERSION}|{range_days}|{project_id:?}|{tz_minutes}|{last_turn:?}")
            .as_bytes(),
    );
    Ok(u64::from_be_bytes(
        digest.as_slice()[..8].try_into().expect("8 bytes"),
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub range: Range,
    pub scope: Scope,
    pub cards: Cards,
    pub diagnostics: Diagnostics,
    pub daily_totals: Vec<DayTotal>,
    pub daily_by_model: Vec<DayModel>,
    pub model_usage: Vec<ModelUsage>,
    pub project_usage: Vec<ProjectUsage>,
    pub heatmap: Vec<DayTotal>,
    pub generated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub project_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cards {
    pub total_tokens: i64,
    pub peak_day_tokens: i64,
    pub longest_chat_ms: i64,
    pub current_streak_days: i64,
    pub longest_streak_days: i64,
    pub session_count: i64,
    pub turn_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub cache_leverage: f64,
    pub cache_read_tokens: i64,
    pub large_context_turn_share: f64,
    pub top5_session_share: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    pub date: String,
    pub tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayModel {
    pub date: String,
    pub model_id: String,
    pub tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model_id: String,
    pub tokens: i64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub tokens: i64,
    pub share: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSession {
    pub session_id: String,
    pub title: Option<String>,
    pub tokens: i64,
    pub turn_count: i64,
    pub last_active_ms: i64,
}

fn local_date(ms: i64) -> String {
    use chrono::TimeZone;
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.date_naive().format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

struct TurnRow {
    started_at: i64,
    ended_ms: i64,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    model_id: Option<String>,
    session_id: String,
    project_id: Option<i64>,
}

fn scan_window(
    db: &Database,
    start_ms: i64,
    end_ms: i64,
    project_id: Option<i64>,
) -> Result<Vec<TurnRow>> {
    let mut statement = db.conn().prepare(
        "SELECT t.started_at, t.ended_at, t.input_tokens, t.output_tokens, t.usage_json,
                t.model_id, t.session_id, s.project_id
         FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.status = 'completed' AND t.ended_at IS NOT NULL
           AND t.started_at >= ?1 AND t.started_at <= ?2
           AND (?3 IS NULL OR s.project_id = ?3)",
    )?;
    let rows = statement.query_map(params![start_ms, end_ms, project_id], |row| {
        let usage_json: Option<String> = row.get(4)?;
        let (cache_read, cache_write) = usage_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<Value>(json).ok())
            .map(|value| {
                (
                    value
                        .get("cacheReadTokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    value
                        .get("cacheWriteTokens")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        Ok(TurnRow {
            started_at: row.get(0)?,
            ended_ms: row.get(1)?,
            input: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            output: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            cache_read,
            cache_write,
            model_id: row.get(5)?,
            session_id: row.get(6)?,
            project_id: row.get(7)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn streaks(days: &BTreeSet<String>) -> (i64, i64) {
    if days.is_empty() {
        return (0, 0);
    }
    // Current streak: anchored on today, or yesterday when today is inactive.
    let mut current = 0i64;
    let today = Local::now().date_naive();
    for anchor in [today, today - chrono::Duration::days(1)] {
        let mut cursor = anchor;
        current = 0;
        while days.contains(&cursor.format("%Y-%m-%d").to_string()) {
            current += 1;
            cursor -= chrono::Duration::days(1);
        }
        if current > 0 {
            break;
        }
    }
    // Longest streak across the collected (bounded) window.
    let sorted: Vec<&String> = days.iter().collect();
    let parse = |s: &String| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d");
    let mut longest = 1i64;
    let mut run = 1i64;
    for pair in sorted.windows(2) {
        let (previous, day) = (parse(pair[0]), parse(pair[1]));
        match (previous, day) {
            (Ok(previous), Ok(day)) if (day - previous).num_days() == 1 => run += 1,
            _ => run = 1,
        }
        longest = longest.max(run);
    }
    (current, longest)
}

pub fn summary(db: &Database, range_days: i64, project_id: Option<i64>) -> Result<Summary> {
    let end_ms = now_ms();
    let scan_start = end_ms - HEATMAP_DAYS * 24 * 3600 * 1000;
    let range_start = end_ms - range_days * 24 * 3600 * 1000;
    let rows = scan_window(db, scan_start, end_ms, project_id)?;

    let mut daily: BTreeMap<String, i64> = BTreeMap::new();
    let mut daily_model: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut models: BTreeMap<String, i64> = BTreeMap::new();
    let mut projects: BTreeMap<Option<i64>, i64> = BTreeMap::new();
    let mut session_tokens: BTreeMap<String, i64> = BTreeMap::new();
    let mut session_chat_ms: BTreeMap<String, i64> = BTreeMap::new();
    let mut active_days = BTreeSet::new();
    let mut cards = Cards {
        total_tokens: 0,
        peak_day_tokens: 0,
        longest_chat_ms: 0,
        current_streak_days: 0,
        longest_streak_days: 0,
        session_count: 0,
        turn_count: 0,
    };
    let mut cache_read_total = 0i64;
    let mut large_context = 0i64;

    for row in &rows {
        let tokens = row.input + row.output;
        let date = local_date(row.started_at);
        let in_range = row.started_at >= range_start;
        if in_range {
            cards.total_tokens += tokens;
            cards.turn_count += 1;
            *daily.entry(date.clone()).or_default() += tokens;
            *daily_model
                .entry((
                    date.clone(),
                    row.model_id.clone().unwrap_or_else(|| "other".into()),
                ))
                .or_default() += tokens;
            *models
                .entry(row.model_id.clone().unwrap_or_else(|| "other".into()))
                .or_default() += tokens;
            *projects.entry(row.project_id).or_default() += tokens;
            *session_tokens.entry(row.session_id.clone()).or_default() += tokens;
            *session_chat_ms.entry(row.session_id.clone()).or_default() +=
                (row.ended_ms - row.started_at).max(0);
            cache_read_total += row.cache_read;
            if row.input + row.cache_read + row.cache_write > LARGE_CONTEXT_TOKENS {
                large_context += 1;
            }
        }
        // Heatmap covers the full 365-day window regardless of range/scope.
        *daily.entry(local_date(row.started_at)).or_default() += tokens;
        active_days.insert(local_date(row.started_at));
    }

    cards.peak_day_tokens = daily
        .iter()
        .filter(|(date, _)| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map(|d| (Local::now().date_naive() - d).num_days() < range_days)
                .unwrap_or(false)
        })
        .map(|(_, tokens)| *tokens)
        .max()
        .unwrap_or(0);
    cards.longest_chat_ms = session_chat_ms.values().copied().max().unwrap_or(0);
    cards.session_count = session_tokens.len() as i64;
    (cards.current_streak_days, cards.longest_streak_days) = streaks(&active_days);

    let range_total = cards.total_tokens.max(1) as f64;
    let model_usage = {
        let mut usage: Vec<ModelUsage> = models
            .into_iter()
            .map(|(model_id, tokens)| ModelUsage {
                share: tokens as f64 / range_total,
                model_id,
                tokens,
            })
            .collect();
        usage.sort_by(|a, b| b.tokens.cmp(&a.tokens));
        usage
    };
    let project_names = project_names(db)?;
    let mut project_usage: Vec<ProjectUsage> = projects
        .into_iter()
        .map(|(project_id, tokens)| ProjectUsage {
            project_name: project_id.and_then(|id| project_names.get(&id).cloned()),
            share: tokens as f64 / range_total,
            project_id,
            tokens,
        })
        .collect();
    project_usage.sort_by(|a, b| b.tokens.cmp(&a.tokens));

    let session_total = session_tokens.values().copied().sum::<i64>().max(1) as f64;
    let top5: i64 = {
        let mut values: Vec<i64> = session_tokens.values().copied().collect();
        values.sort_unstable_by(|a, b| b.cmp(a));
        values.iter().take(5).sum()
    };
    let diagnostics = Diagnostics {
        cache_leverage: cache_read_total as f64
            / (cards.total_tokens + cache_read_total).max(1) as f64,
        cache_read_tokens: cache_read_total,
        large_context_turn_share: large_context as f64 / cards.turn_count.max(1) as f64,
        top5_session_share: top5 as f64 / session_total,
    };

    Ok(Summary {
        range: Range {
            start_ms: range_start,
            end_ms,
        },
        scope: Scope { project_id },
        cards,
        diagnostics,
        daily_totals: daily
            .iter()
            .map(|(date, tokens)| DayTotal {
                date: date.clone(),
                tokens: *tokens,
            })
            .collect(),
        daily_by_model: daily_model
            .into_iter()
            .map(|((date, model_id), tokens)| DayModel {
                date,
                model_id,
                tokens,
            })
            .collect(),
        model_usage,
        project_usage,
        heatmap: daily
            .iter()
            .map(|(date, tokens)| DayTotal {
                date: date.clone(),
                tokens: *tokens,
            })
            .collect(),
        generated_at: now_ms(),
    })
}

fn project_names(db: &Database) -> Result<BTreeMap<i64, String>> {
    let mut statement = db.conn().prepare("SELECT id, name FROM projects")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .map_err(Into::into)
}

pub fn top_sessions(
    db: &Database,
    range_days: i64,
    project_id: Option<i64>,
    limit: i64,
) -> Result<Vec<TopSession>> {
    let end_ms = now_ms();
    let start_ms = end_ms - range_days * 24 * 3600 * 1000;
    let rows = scan_window(db, start_ms, end_ms, project_id)?;
    let mut sessions: BTreeMap<String, (i64, i64, Option<String>)> = BTreeMap::new();
    for row in &rows {
        let entry = sessions.entry(row.session_id.clone()).or_default();
        entry.0 += row.input + row.output;
        entry.1 += 1;
    }
    for row in db
        .conn()
        .prepare("SELECT id, title FROM sessions")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
    {
        let (id, title) = row?;
        if let Some(entry) = sessions.get_mut(&id) {
            entry.2 = title;
        }
    }
    let mut list: Vec<(String, i64, i64)> = sessions
        .into_iter()
        .map(|(id, (tokens, turns, _))| (id, tokens, turns))
        .collect();
    list.sort_unstable_by(|a, b| b.1.cmp(&a.1));
    Ok(list
        .into_iter()
        .take(limit.max(0) as usize)
        .map(|(session_id, tokens, turn_count)| TopSession {
            last_active_ms: 0,
            title: None,
            session_id,
            tokens,
            turn_count,
        })
        .collect())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    fn setup_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_session(db: &Database, id: &str) {
        db.conn()
            .execute("INSERT INTO sessions (id, mode, created_at, updated_at) VALUES (?1, 'agent', ?2, ?2)", params![id, now_ms()])
            .context("insert session")
            .unwrap();
    }

    fn insert_turn(
        db: &Database,
        id: &str,
        session: &str,
        started: i64,
        ended: i64,
        input: i64,
        output: i64,
        cache_read: i64,
        model: &str,
    ) {
        db.conn()
            .execute(
                "INSERT INTO turns (id, session_id, status, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at)
                 VALUES (?1, ?2, 'completed', ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    session,
                    model,
                    input,
                    output,
                    serde_json::json!({ "cacheReadTokens": cache_read }).to_string(),
                    started,
                    ended
                ],
            )
            .unwrap();
    }

    #[test]
    fn summary_cards_diagnostics_and_streaks() {
        let (_dir, db) = setup_db();
        insert_session(&db, "s1");
        insert_session(&db, "s2");
        let now = now_ms();
        let day = |back: i64| now - back * 24 * 3600 * 1000;
        // s1: today + yesterday; s2: 3 days ago, one large-context turn.
        insert_turn(
            &db,
            "t1",
            "s1",
            day(0),
            day(0) + 60_000,
            1_000,
            2_000,
            8_000,
            "model-a",
        );
        insert_turn(
            &db,
            "t2",
            "s1",
            day(1),
            day(1) + 60_000,
            500,
            500,
            0,
            "model-a",
        );
        insert_turn(
            &db,
            "t3",
            "s2",
            day(3),
            day(3) + 120_000,
            90_000,
            20_000,
            15_000,
            "model-b",
        );
        let summary = summary(&db, 7, None).unwrap();
        assert_eq!(summary.cards.turn_count, 3);
        assert_eq!(summary.cards.total_tokens, 114_000);
        assert_eq!(summary.cards.session_count, 2);
        assert_eq!(summary.cards.current_streak_days, 2);
        assert_eq!(summary.cards.longest_streak_days, 2);
        assert_eq!(summary.cards.longest_chat_ms, 120_000);
        assert!(summary.diagnostics.cache_leverage > 0.0);
        assert!(summary.diagnostics.large_context_turn_share > 0.0);
        assert_eq!(summary.model_usage[0].model_id, "model-b");
        assert_eq!(summary.heatmap.last().unwrap().tokens > 0, true);
    }

    #[test]
    fn empty_database_yields_zeroed_summary() {
        let (_dir, db) = setup_db();
        let summary = summary(&db, 7, None).unwrap();
        assert_eq!(summary.cards.total_tokens, 0);
        assert_eq!(summary.cards.current_streak_days, 0);
        assert!(summary.heatmap.is_empty());
    }

    #[test]
    fn top_sessions_rank_by_tokens() {
        let (_dir, db) = setup_db();
        insert_session(&db, "s1");
        insert_session(&db, "s2");
        let now = now_ms();
        insert_turn(&db, "t1", "s1", now - 1000, now, 100, 100, 0, "m");
        insert_turn(&db, "t2", "s2", now - 1000, now, 5_000, 5_000, 0, "m");
        let top = top_sessions(&db, 7, None, 5).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].session_id, "s2");
        assert_eq!(top[0].tokens, 10_000);
    }

    #[test]
    fn cache_round_trips_by_key_and_ttl() {
        let cache = SummaryCache::default();
        assert!(cache.get(7, now_ms()).is_none());
        cache.put(7, now_ms(), serde_json::json!({ "hit": true }));
        assert!(cache.get(7, now_ms()).is_some());
        assert!(cache.get(8, now_ms()).is_none());
        assert!(cache.get(7, now_ms() + CACHE_TTL_MS + 1).is_none());
    }
}
