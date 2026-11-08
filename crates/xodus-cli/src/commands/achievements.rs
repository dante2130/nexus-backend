//! Read-only Xbox Achievements V2. Never emits achievement progress or unlock writes.
use std::{collections::{HashMap, HashSet}, process::ExitCode, time::Duration};
use serde_json::{Value, json};
use xodus::tokens::TokenManager;
use super::profile::{bounded, xbox_session};

fn short(value: &Value, limit: usize) -> Option<String> {
    let s = value.as_str()?;
    if s.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') { return None; }
    let mut result = String::new(); let mut length = 0;
    for c in s.chars() { length += c.len_utf16(); if length > limit { break; } result.push(c); }
    Some(result)
}
fn scid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i,b)|
        if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
fn title_matches(value: &Value, title: u32) -> bool {
    value.as_u64() == Some(u64::from(title)) || value.as_str() == Some(title.to_string().as_str())
}
fn safe_icon(value: &Value) -> Option<String> {
    let raw = value.as_str()?;
    if raw.len() > 2048 { return None; }
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() { return None; }
    if !["images-eds-ssl.xboxlive.com","images-eds.xboxlive.com","store-images.s-microsoft.com"].contains(&url.host_str()?) { return None; }
    Some(url.to_string())
}
fn number(value: &Value) -> Option<f64> {
    let s = value.as_str()?;
    if s.is_empty() || s.len() > 32 || !s.bytes().all(|c| c.is_ascii_digit() || c == b'.') { return None; }
    s.parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0)
}

// REST currentPercentage is already expressed in percentage points.
fn rarity(value: &Value) -> Option<Value> {
    let percentage = value["currentPercentage"].as_f64()
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))?;
    let category = match value["currentCategory"].as_str() {
        Some("Rare") => "Rare",
        Some("Common") => "Common",
        _ => return None,
    };
    Some(json!({"percentage":percentage,"category":category}))
}

fn achievement(value: &Value, title_id: u32) -> Result<Value, &'static str> {
    let id = short(&value["id"],128).filter(|s| !s.is_empty()).ok_or("achievement-id")?;
    let service = value["serviceConfigId"].as_str().filter(|s| scid(s)).ok_or("achievement-service")?;
    if !value["titleAssociations"].as_array().ok_or("achievement-titles")?.iter().any(|v| title_matches(&v["id"],title_id)) { return Err("achievement-title"); }
    if value["achievementType"].as_str() != Some("Persistent") { return Err("achievement-type"); }
    let revoked = value["isRevoked"].as_bool().ok_or("achievement-revoked")?;
    let secret = value["isSecret"].as_bool().ok_or("achievement-secret")?;
    let state = match value["progressState"].as_str() {
        Some("Achieved") if !revoked => "unlocked",
        Some("Achieved") | Some("NotStarted") => "locked",
        Some("InProgress") => if revoked { "locked" } else { "in-progress" },
        _ => return Err("achievement-state"),
    };
    let name = short(&value["name"],256).filter(|s| !s.is_empty()).ok_or("achievement-name")?;
    let description = short(&value[if state == "unlocked" { "description" } else { "lockedDescription" }],1500).ok_or("achievement-description")?;
    let mut score = None;
    for reward in value["rewards"].as_array().ok_or("achievement-rewards")? {
        if reward["type"].as_str() != Some("Gamerscore") { continue; }
        let n = reward["value"].as_str().and_then(|s| s.parse::<u32>().ok()).filter(|n| *n <= 10_000).ok_or("achievement-score")?;
        if score.is_some_and(|old| old != n) { return Err("achievement-score-conflict"); }
        score = Some(n);
    }
    let date = if state == "unlocked" { short(&value["progression"]["timeUnlocked"],40)
        .filter(|s| s.len() >= 20 && s.is_ascii() && s.as_bytes().get(4) == Some(&b'-') && s.as_bytes().get(10) == Some(&b'T')) } else { None };
    let progress = if state != "unlocked" && !revoked {
        value["progression"]["requirements"].as_array().filter(|v| v.len() == 1).and_then(|v| {
            let current = number(&v[0]["current"])?;
            let target = number(&v[0]["target"])?;
            (target > 0.0 && current <= target).then_some(current / target * 100.0)
        })
    } else { None };
    let icon = value["mediaAssets"].as_array().and_then(|v| v.iter().take(20)
        .filter(|asset| asset["type"].as_str() == Some("Icon")).find_map(|asset| safe_icon(&asset["url"])));
    Ok(json!({"id":format!("{}:{id}",service.to_ascii_lowercase()),"name":name,"description":description,
        "state":state,"secret":secret,"revoked":revoked,"gamerscore":score,"unlockedAt":date,"iconUrl":icon,"progress":progress,"rarity":rarity(&value["rarity"])}))
}

fn page(value: &Value, title: u32) -> Result<(Vec<Value>,Option<String>,bool), &'static str> {
    let rows = value["achievements"].as_array().filter(|v| v.len() <= 500).ok_or("achievements-shape")?;
    let paging = value["pagingInfo"].as_object().ok_or("achievements-paging")?;
    let token = match paging.get("continuationToken") {
        Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control) => Some(s.clone()),
        _ => return Err("achievements-token"),
    };
    let mut items = Vec::new(); let mut partial = false;
    for row in rows {
        // A response for another title must never become a valid partial list.
        if !row["titleAssociations"].as_array().is_some_and(|v| v.iter().any(|a| title_matches(&a["id"],title))) { return Err("achievement-title"); }
        match achievement(row,title) { Ok(item) => items.push(item), Err(_) => partial = true }
    }
    Ok((items,token,partial))
}

fn valid_language(language: &str) -> bool {
    let parts: Vec<_> = language.split('-').collect();
    parts.len() == 2 && (2..=3).contains(&parts[0].len()) && parts[1].len() == 2
        && parts.iter().all(|part| part.bytes().all(|c| c.is_ascii_alphabetic()))
}

// The BaseGame completion group is supplied by Xbox, never inferred from score.
fn mythic_completion(value: &Value, title: u32) -> Option<Value> {
    for completion in value["completion"].as_array()?.iter().take(100) {
        if !title_matches(&completion["titleId"], title) { continue; }
        for (id, group) in completion["groups"].as_object()?.iter().take(100) {
            if group["groupType"] != "BaseGame" { continue; }
            if id.is_empty() || id.len() > 180 { return None; }
            let ids = group["achievementIds"].as_array().filter(|v| !v.is_empty() && v.len() <= 500)?;
            let unlocked = group["unlockedAchievementIds"].as_array().filter(|v| v.len() <= 500)?;
            let collect = |values: &[Value]| -> Option<HashSet<String>> {
                let mut found = HashSet::new();
                for value in values {
                    let text = value.as_str().filter(|s| !s.is_empty() && s.len() <= 180 && !s.chars().any(char::is_control))?;
                    if !found.insert(text.to_owned()) { return None; }
                }
                Some(found)
            };
            let all = collect(ids)?;
            let earned = collect(unlocked)?;
            if !earned.is_subset(&all) { return None; }
            let complete = group["isComplete"].as_bool()?;
            let completed_at = group["completedTime"].as_str().and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()).map(|v| v.to_rfc3339());
            return Some(json!({"groupId":id,"unlocked":complete,"unlockedCount":earned.len(),
                "totalCount":all.len(),"completedTime":completed_at,"achievementIds":ids}));
        }
    }
    None
}

fn attach_mythic(items: &mut [Value], completion: &Value) {
    let Some(base_ids) = completion["achievementIds"].as_array() else { return; };
    let mut occurrences = HashMap::<String, usize>::new();
    for item in items.iter() {
        if let Some(raw_id) = item["id"].as_str().and_then(|id| id.rsplit(':').next()) {
            *occurrences.entry(raw_id.to_owned()).or_default() += 1;
        }
    }
    for item in items {
        let Some(raw_id) = item["id"].as_str().and_then(|id| id.rsplit(':').next()) else { continue; };
        if occurrences.get(raw_id) != Some(&1) { continue; }
        let is_base = base_ids.iter().any(|id| id.as_str() == Some(raw_id));
        item["baseGame"] = json!(is_base);
    }
}

async fn lookup(tokens: &TokenManager, title: u32, language: &str, include_mythic: bool) -> Result<Value, &'static str> {
    let snapshot=tokens.user_token_snapshot().map_err(|_|"account-changed")?;
    let (client,authorization,account) = xbox_session(tokens).await?;
    let response = client.get("https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag")
        .header("Authorization",&authorization).header("x-xbl-contract-version","2")
        .send().await.map_err(|_| "profile-request")?;
    let profile: Value = serde_json::from_slice(&bounded(response,128*1024).await?).map_err(|_| "profile-json")?;
    let users = profile["profileUsers"].as_array().filter(|v| v.len() == 1).ok_or("profile-count")?;
    let xuid = users[0]["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 20 && s.bytes().all(|c| c.is_ascii_digit()) && s.parse::<u64>().is_ok_and(|n| n>0)).ok_or("profile-id")?;
    let mut items = Vec::new(); let mut token: Option<String> = None; let mut seen = HashSet::new(); let mut ids = HashSet::new(); let mut partial = false;
    let mut mythic: Option<Value> = None;
    for index in 0..10 {
        let mut url = reqwest::Url::parse(&format!("https://achievements.xboxlive.com/users/xuid({xuid})/achievements")).map_err(|_| "request-url")?;
        url.query_pairs_mut().append_pair("titleId",&title.to_string()).append_pair("types","Persistent").append_pair("maxItems","100");
        if include_mythic { url.query_pairs_mut().append_pair("possibleOnly","true"); }
        if let Some(ref next) = token { url.query_pairs_mut().append_pair("continuationToken",next); }
        let response = client.get(url).header("Authorization",&authorization).header("x-xbl-contract-version",if include_mythic { "6" } else { "2" })
            .header("Accept-Language",language).send().await.map_err(|_| "achievements-request")?;
        let body: Value = serde_json::from_slice(&bounded(response,2*1024*1024).await?).map_err(|_| "achievements-json")?;
        if include_mythic && mythic.is_none() { mythic = mythic_completion(&body,title); }
        let (rows,next,omitted) = page(&body,title)?; partial |= omitted;
        for row in rows {
            if !ids.insert(row["id"].as_str().ok_or("achievement-id")?.to_owned()) { return Err("achievement-duplicate"); }
            if items.len() == 500 { partial = true; break; }
            items.push(row);
        }
        let Some(next) = next else { break; };
        if !seen.insert(next.clone()) { return Err("achievements-pagination-loop"); }
        if items.len() == 500 || index == 9 { partial = true; break; }
        token = Some(next);
    }
    tokens.validate_user_token_snapshot(&snapshot).map_err(|_|"account-changed")?;
    if let Some(ref completion) = mythic { attach_mythic(&mut items,completion); }
    Ok(json!({"schema":1,"account":account,"titleId":title.to_string(),"items":items,"partial":partial,"mythic":mythic}))
}

pub async fn run(tokens: &TokenManager, title_id: u32, json_output: bool, language: &str, include_mythic: bool) -> ExitCode {
    if !valid_language(language) { eprintln!("Xbox achievements unavailable: invalid-language"); return ExitCode::FAILURE; }
    if title_id == 0 { eprintln!("Xbox achievements unavailable: invalid-title"); return ExitCode::FAILURE; }
    match tokio::time::timeout(Duration::from_secs(30),lookup(tokens,title_id,language,include_mythic)).await {
        Ok(Ok(value)) => {
            if json_output { println!("{value}"); } else { println!("{} achievements",value["items"].as_array().map_or(0,Vec::len)); }
            ExitCode::SUCCESS
        }
        _ => { eprintln!("Xbox achievements unavailable: request-failed"); ExitCode::FAILURE }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rarity_preserves_percentage_points_and_server_category() {
        for percent in [0.0, 0.27, 10.9, 100.0] {
            assert_eq!(rarity(&json!({"currentPercentage":percent,"currentCategory":"Rare"})),
                Some(json!({"percentage":percent,"category":"Rare"})));
        }
        for value in [Value::Null, json!({}), json!({"currentPercentage":true,"currentCategory":"Rare"}),
            json!({"currentPercentage":-1,"currentCategory":"Rare"}),
            json!({"currentPercentage":101,"currentCategory":"Rare"}),
            json!({"currentPercentage":2,"currentCategory":"Unset"})] {
            assert!(rarity(&value).is_none());
        }
        let mut input = row();
        input["rarity"] = json!({"currentPercentage":101,"currentCategory":"Rare"});
        assert!(achievement(&input,42).unwrap()["rarity"].is_null());
    }
    #[test] fn language_tags_reject_header_injection() {
        for tag in ["en-US", "uk-UA", "ru-RU", "pt-BR", "zh-CN"] { assert!(valid_language(tag)); }
        for tag in ["", "en", "../en-US", "en-US\r\nX: y", "en-US,ru-RU"] { assert!(!valid_language(tag)); }
    }
    fn completion(complete: bool) -> Value { json!({"completion":[{"titleId":"42","groups":{
        "base":{"groupType":"BaseGame","achievementIds":["1","2"],"unlockedAchievementIds":["1"],"isComplete":complete,"completedTime":null},
        "dlc":{"groupType":"AddOn","achievementIds":["3"],"unlockedAchievementIds":[],"isComplete":false}
    }}]}) }
    #[test] fn mythic_uses_only_the_matching_server_base_game_group() {
        let value = mythic_completion(&completion(false),42).unwrap();
        assert_eq!(value["totalCount"],2); assert_eq!(value["unlockedCount"],1); assert_eq!(value["unlocked"],false);
        assert!(mythic_completion(&completion(false),43).is_none());
        assert!(mythic_completion(&json!({}),42).is_none());
        assert_eq!(mythic_completion(&completion(true),42).unwrap()["unlocked"],true);
    }
    #[test] fn mythic_never_guesses_completion_or_accepts_invalid_membership() {
        let mut value=completion(false);
        value["completion"][0]["groups"]["base"]["unlockedAchievementIds"]=json!(["1","2"]);
        assert_eq!(mythic_completion(&value,42).unwrap()["unlocked"],false);
        value["completion"][0]["groups"]["base"]["unlockedAchievementIds"]=json!(["3"]);
        assert!(mythic_completion(&value,42).is_none());
        value["completion"][0]["groups"]["base"]["unlockedAchievementIds"]=json!(["1","1"]);
        assert!(mythic_completion(&value,42).is_none());
    }
    #[test] fn mythic_marks_originals_and_excludes_addons() {
        let group=mythic_completion(&completion(false),42).unwrap();
        let mut items=vec![json!({"id":"scid:1"}),json!({"id":"scid:3"})];
        attach_mythic(&mut items,&group);
        assert_eq!(items[0]["baseGame"],true);assert_eq!(items[1]["baseGame"],false);
        let mut ambiguous=vec![json!({"id":"scid:1"}),json!({"id":"another-scid:1"})];
        attach_mythic(&mut ambiguous,&group);
        assert!(ambiguous[0]["baseGame"].is_null());assert!(ambiguous[1]["baseGame"].is_null());
    }
    fn row() -> Value { json!({"id":"1","serviceConfigId":"11111111-1111-4111-8111-111111111111","titleAssociations":[{"id":42}],"achievementType":"Persistent","name":"First step","description":"Unlocked","lockedDescription":"Do something","progressState":"Achieved","isSecret":false,"isRevoked":false,"rewards":[{"type":"Gamerscore","value":"10"}],"progression":{"timeUnlocked":"2026-01-01T12:00:00Z"},"mediaAssets":[{"type":"Icon","url":"https://images-eds-ssl.xboxlive.com/image"}]}) }
    #[test] fn reads_unlocked_and_missing_does_not_mean_zero() {
        let v=achievement(&row(),42).unwrap(); assert_eq!(v["state"],"unlocked");assert_eq!(v["gamerscore"],10);assert!(v["unlockedAt"].is_string());
        let mut r=row();r["rewards"]=json!([]);assert!(achievement(&r,42).unwrap()["gamerscore"].is_null());
        r["rewards"]=json!([{"type":"Gamerscore","value":"0"}]);assert_eq!(achievement(&r,42).unwrap()["gamerscore"],0);
    }
    #[test] fn revoked_and_locked_never_keep_unlock_date() {
        let mut r=row();r["isRevoked"]=json!(true);let v=achievement(&r,42).unwrap();assert_eq!(v["state"],"locked");assert!(v["unlockedAt"].is_null());
        r["isRevoked"]=json!(false);r["progressState"]=json!("InProgress");r["isSecret"]=json!(true);r["progression"]["requirements"]=json!([{"current":"2","target":"5"}]);
        let v=achievement(&r,42).unwrap();assert_eq!(v["progress"],40.0);assert_eq!(v["description"],"Do something");assert_eq!(v["secret"],true);
    }
    #[test] fn rejects_wrong_title_bad_envelope_and_malformed_paging() {
        assert!(achievement(&row(),43).is_err());assert!(page(&json!({}),42).is_err());
        assert!(page(&json!({"achievements":[row()],"pagingInfo":{"continuationToken":"bad\n"}}),42).is_err());
        assert!(page(&json!({"achievements":[row()],"pagingInfo":{"continuationToken":null}}),43).is_err());
        let (v,next,partial)=page(&json!({"achievements":[],"pagingInfo":{"continuationToken":null}}),42).unwrap();assert!(v.is_empty());assert!(next.is_none());assert!(!partial);
    }
    #[test] fn icons_and_progress_are_bounded_not_guessed() {
        for url in ["file:///etc/passwd","https://evil.test/icon","https://user:secret@images-eds-ssl.xboxlive.com/a","http://images-eds-ssl.xboxlive.com/a"] { assert!(safe_icon(&json!(url)).is_none()); }
        let mut r=row();r["progressState"]=json!("InProgress");r["progression"]["requirements"]=json!([{"current":"2","target":"5"},{"current":"0","target":"3"}]);assert!(achievement(&r,42).unwrap()["progress"].is_null());
        r["progressState"]=json!("Unknown");assert!(achievement(&r,42).is_err());
    }
}
