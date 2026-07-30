fn main() {
    let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
    let output = successor_sim::current_authority_replay_json(fixture)
        .expect("current authority replay fixture serializes");
    println!("{output}");
}
