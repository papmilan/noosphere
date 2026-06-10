module noosphere::noosphere;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};

const INITIAL_REPUTATION_SCORE: u64 = 500;
const MAX_REPUTATION_SCORE: u64 = 1000;
const MAX_BLOB_IDS: u64 = 10_000;

const ENotOwner: u64 = 0;
const EDuplicateAgent: u64 = 1;
const ETooManyBlobs: u64 = 2;

public struct AgentGenome has key, store {
    id: UID,
    owner: address,
    agent_name: String,
    project_id: String,
    reputation_score: u64,
    decision_count: u64,
    walrus_blob_ids: vector<String>,
    created_at: u64,
    last_updated: u64,
}

public struct ProjectRegistry has key, store {
    id: UID,
    project_id: String,
    agent_genomes: vector<address>,
}

public struct DecisionScored has copy, drop {
    genome_id: ID,
    agent_name: String,
    project_id: String,
    blob_id: String,
    score_delta: u64,
    is_positive: bool,
    new_total_score: u64,
    decision_count: u64,
    timestamp: u64,
    scorer_version: String,
}

public fun create_genome(
    agent_name: String,
    project_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let timestamp = clock::timestamp_ms(clock);

    transfer::share_object(AgentGenome {
        id: object::new(ctx),
        owner: tx_context::sender(ctx),
        agent_name,
        project_id,
        reputation_score: INITIAL_REPUTATION_SCORE,
        decision_count: 0,
        walrus_blob_ids: vector[],
        created_at: timestamp,
        last_updated: timestamp,
    });
}

public fun add_decision(
    genome: &mut AgentGenome,
    blob_id: String,
    score_delta: u64,
    is_positive: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(genome.owner == tx_context::sender(ctx), ENotOwner);
    assert!(genome.walrus_blob_ids.length() < MAX_BLOB_IDS, ETooManyBlobs);

    if (is_positive) {
        let room_to_max = MAX_REPUTATION_SCORE - genome.reputation_score;
        genome.reputation_score = if (score_delta >= room_to_max) {
            MAX_REPUTATION_SCORE
        } else {
            genome.reputation_score + score_delta
        };
    } else {
        genome.reputation_score = if (score_delta >= genome.reputation_score) {
            0
        } else {
            genome.reputation_score - score_delta
        };
    };

    let timestamp = clock::timestamp_ms(clock);
    genome.walrus_blob_ids.push_back(blob_id);
    genome.decision_count = genome.decision_count + 1;
    genome.last_updated = timestamp;

    event::emit(DecisionScored {
        genome_id: object::id(genome),
        agent_name: genome.agent_name,
        project_id: genome.project_id,
        blob_id,
        score_delta,
        is_positive,
        new_total_score: genome.reputation_score,
        decision_count: genome.decision_count,
        timestamp,
        scorer_version: b"noosphere-scorer-v1.0".to_string(),
    });
}

public fun get_score(genome: &AgentGenome): u64 {
    genome.reputation_score
}

public fun get_blob_ids(genome: &AgentGenome): vector<String> {
    genome.walrus_blob_ids
}

public fun create_project_registry(project_id: String, ctx: &mut TxContext) {
    transfer::share_object(ProjectRegistry {
        id: object::new(ctx),
        project_id,
        agent_genomes: vector[],
    });
}

public fun register_agent(
    registry: &mut ProjectRegistry,
    genome_address: address,
    _ctx: &mut TxContext,
) {
    assert!(
        !registry.agent_genomes.contains(&genome_address),
        EDuplicateAgent,
    );
    registry.agent_genomes.push_back(genome_address);
}

public fun get_project_agents(registry: &ProjectRegistry): vector<address> {
    registry.agent_genomes
}

#[test_only]
use sui::clock::create_for_testing;
#[test_only]
use sui::test_scenario;

#[test]
fun test_create_genome_initial_state() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        create_genome(
            b"test-agent".to_string(),
            b"test-project".to_string(),
            &clock,
            test_scenario::ctx(&mut scenario),
        );
        clock.destroy_for_testing();
    };
    test_scenario::next_tx(&mut scenario, @0xA);
    {
        let genome = test_scenario::take_shared<AgentGenome>(&scenario);
        assert!(genome.reputation_score == INITIAL_REPUTATION_SCORE, 0);
        assert!(genome.decision_count == 0, 0);
        assert!(genome.owner == @0xA, 0);
        test_scenario::return_shared(genome);
    };
    test_scenario::end(scenario);
}

#[test]
fun test_add_decision_positive() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        create_genome(
            b"agent".to_string(),
            b"proj".to_string(),
            &clock,
            test_scenario::ctx(&mut scenario),
        );
        clock.destroy_for_testing();
    };
    test_scenario::next_tx(&mut scenario, @0xA);
    {
        let mut genome = test_scenario::take_shared<AgentGenome>(&scenario);
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        add_decision(&mut genome, b"blob1".to_string(), 100, true, &clock, test_scenario::ctx(&mut scenario));
        assert!(genome.reputation_score == 600, 0);
        assert!(genome.decision_count == 1, 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(genome);
    };
    test_scenario::end(scenario);
}

#[test]
fun test_add_decision_negative() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        create_genome(b"agent".to_string(), b"proj".to_string(), &clock, test_scenario::ctx(&mut scenario));
        clock.destroy_for_testing();
    };
    test_scenario::next_tx(&mut scenario, @0xA);
    {
        let mut genome = test_scenario::take_shared<AgentGenome>(&scenario);
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        add_decision(&mut genome, b"blob1".to_string(), 200, false, &clock, test_scenario::ctx(&mut scenario));
        assert!(genome.reputation_score == 300, 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(genome);
    };
    test_scenario::end(scenario);
}

#[test]
fun test_score_clamps_at_max() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        create_genome(b"agent".to_string(), b"proj".to_string(), &clock, test_scenario::ctx(&mut scenario));
        clock.destroy_for_testing();
    };
    test_scenario::next_tx(&mut scenario, @0xA);
    {
        let mut genome = test_scenario::take_shared<AgentGenome>(&scenario);
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        add_decision(&mut genome, b"blob1".to_string(), 999, true, &clock, test_scenario::ctx(&mut scenario));
        assert!(genome.reputation_score == MAX_REPUTATION_SCORE, 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(genome);
    };
    test_scenario::end(scenario);
}

#[test]
fun test_score_clamps_at_zero() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        create_genome(b"agent".to_string(), b"proj".to_string(), &clock, test_scenario::ctx(&mut scenario));
        clock.destroy_for_testing();
    };
    test_scenario::next_tx(&mut scenario, @0xA);
    {
        let mut genome = test_scenario::take_shared<AgentGenome>(&scenario);
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        add_decision(&mut genome, b"blob1".to_string(), 999, false, &clock, test_scenario::ctx(&mut scenario));
        assert!(genome.reputation_score == 0, 0);
        clock.destroy_for_testing();
        test_scenario::return_shared(genome);
    };
    test_scenario::end(scenario);
}

#[test]
#[expected_failure(abort_code = ENotOwner)]
fun test_add_decision_wrong_owner_aborts() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        create_genome(b"agent".to_string(), b"proj".to_string(), &clock, test_scenario::ctx(&mut scenario));
        clock.destroy_for_testing();
    };
    test_scenario::next_tx(&mut scenario, @0xB);
    {
        let mut genome = test_scenario::take_shared<AgentGenome>(&scenario);
        let clock = create_for_testing(test_scenario::ctx(&mut scenario));
        add_decision(&mut genome, b"blob1".to_string(), 10, true, &clock, test_scenario::ctx(&mut scenario));
        clock.destroy_for_testing();
        test_scenario::return_shared(genome);
    };
    test_scenario::end(scenario);
}

#[test]
#[expected_failure(abort_code = EDuplicateAgent)]
fun test_register_agent_duplicate_aborts() {
    let mut scenario = test_scenario::begin(@0xA);
    {
        create_project_registry(b"proj".to_string(), test_scenario::ctx(&mut scenario));
    };
    test_scenario::next_tx(&mut scenario, @0xA);
    {
        let mut registry = test_scenario::take_shared<ProjectRegistry>(&scenario);
        register_agent(&mut registry, @0xB, test_scenario::ctx(&mut scenario));
        register_agent(&mut registry, @0xB, test_scenario::ctx(&mut scenario));
        test_scenario::return_shared(registry);
    };
    test_scenario::end(scenario);
}
