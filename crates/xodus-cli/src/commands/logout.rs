use std::process::ExitCode;
use xodus::tokens::TokenManager;

pub async fn run(tokens: &TokenManager, device: bool, player: bool) -> ExitCode {
    super::subscription::clear();
    let result=if device {tokens.remove_all_accounts_and_device()} else if player {tokens.remove_player()} else {tokens.remove_license()};
    match result {Ok(())=>ExitCode::SUCCESS,Err(error)=>{error.report();ExitCode::FAILURE}}
}
