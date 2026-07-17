import {
  AgenticWorkEpisode,
  ArtifactStateEvidence,
  AttributionDecision,
  AttributionProof,
  MatchedCausalWriteArtifactEvidence,
  ObservedCommitCandidate,
  QueryWorkEvidence
} from "../types";

const CLAIM_WINDOW_MS = 4 * 60 * 60 * 1000;

export type CommitAttributionPolicyInput = {
  candidate: ObservedCommitCandidate;
  episode: AgenticWorkEpisode;
  lineageVerifiedQueryIds: Set<string>;
  activeQueryIds: Set<string>;
  candidateAnchorQueryIds: Set<string>;
};

export type CommitAttributionPolicyResult = {
  decision: AttributionDecision;
  queryIds: string[];
  proof?: AttributionProof;
  reasonCodes: string[];
};

export function evaluateCommitAttribution(input: CommitAttributionPolicyInput): CommitAttributionPolicyResult {
  const { candidate, episode } = input;
  const repositoryEvidence = episode.evidence.filter((evidence) => evidence.repoKey === candidate.repoKey);
  const currentEpochEvidence = repositoryEvidence.filter((evidence) => evidence.epochId === candidate.epochId);
  if (repositoryEvidence.length > 0 && currentEpochEvidence.length === 0) {
    return { decision: "rejected", queryIds: [], reasonCodes: ["epoch_mismatch"] };
  }
  const hardFailure = hardFailureReason(candidate, episode);
  if (hardFailure) {
    return { decision: "rejected", queryIds: [], reasonCodes: [hardFailure] };
  }

  const contentCandidates = currentEpochEvidence
    .filter((evidence) => evidence.baselineTrusted)
    .filter((evidence) => evidence.baselineSequence == null || candidate.observedSequence > evidence.baselineSequence)
    .filter((evidence) => hasContentContinuity(evidence, candidate.artifactStates));
  const provenAnchors = uniqueStrings(contentCandidates
    .filter((evidence) => input.lineageVerifiedQueryIds.has(evidence.queryId))
    .map((evidence) => evidence.queryId));
  const anchors = provenAnchors
    .filter((queryId) => !input.activeQueryIds.has(queryId));
  const retainedCandidateAnchors = provenAnchors
    .filter((queryId) => input.candidateAnchorQueryIds.has(queryId));

  if (anchors.length === 0 && retainedCandidateAnchors.length === 0) {
    return {
      decision: "pending_evidence",
      queryIds: [],
      reasonCodes: provenAnchors.length > 0
        ? ["query_already_claimed_by_other_commit"]
        : currentEpochEvidence.length > 0
        && currentEpochEvidence.every((evidence) => evidence.baselineSequence != null && candidate.observedSequence <= evidence.baselineSequence)
        ? ["candidate_before_evidence_window"]
        : contentCandidates.length > 0
          ? ["lineage_not_verified"]
          : repositoryEvidence.length > 0
          ? ["same_file_without_state_continuity"]
          : ["no_repository_evidence"]
    };
  }

  const episodeRepos = uniqueStrings(episode.evidence.map((evidence) => evidence.repoKey));
  const inherited = episodeRepos.length === 1
    ? episode.queryIds
      .filter((queryId) => !anchors.includes(queryId))
      .filter((queryId) => !input.activeQueryIds.has(queryId))
      .filter((queryId) => !episode.evidence.some((evidence) =>
        evidence.queryId === queryId
        && (
          evidence.repoKey !== candidate.repoKey
          || evidence.epochId !== candidate.epochId
          || (evidence.baselineSequence != null && candidate.observedSequence <= evidence.baselineSequence)
          || !input.lineageVerifiedQueryIds.has(queryId)
        )
      ))
    : [];
  const queryIds = uniqueStrings([...anchors, ...inherited]);
  const proofAnchorQueryIds = uniqueStrings([...anchors, ...retainedCandidateAnchors]);
  const proofEvidence = currentEpochEvidence.filter((evidence) =>
    proofAnchorQueryIds.includes(evidence.queryId)
  );
  const matchedCausalWriteArtifacts = matchedCausalWriteArtifactsForCommit(
    proofEvidence,
    candidate.artifactStates
  );
  const proofKind = proofKindFor(proofEvidence, candidate.artifactStates);
  return {
    decision: "reportable",
    queryIds,
    proof: {
      kind: proofKind,
      anchorQueryIds: proofAnchorQueryIds,
      inheritedQueryIds: inherited,
      matchedArtifactCount: matchedArtifactCount(proofEvidence, candidate.artifactStates),
      ...(matchedCausalWriteArtifacts.length > 0 ? { matchedCausalWriteArtifacts } : {}),
      reasonCodes: uniqueStrings([
        "active_epoch",
        "lineage_verified",
        "content_state_continuity",
        ...(inherited.length > 0 ? ["unambiguous_episode_inheritance"] : [])
      ])
    },
    reasonCodes: ["verified_content_continuity"]
  };
}

function hardFailureReason(
  candidate: ObservedCommitCandidate,
  episode: AgenticWorkEpisode
): string | undefined {
  if (candidate.decision === "legacy_unverified") {
    return "legacy_candidate";
  }
  if (new Date(candidate.observedAt).getTime() < new Date(episode.startedAt).getTime()) {
    return "candidate_before_episode";
  }
  if (new Date(candidate.observedAt).getTime() - new Date(episode.lastAgentActivityAt).getTime() > CLAIM_WINDOW_MS) {
    return "claim_window_expired";
  }
  return undefined;
}

function hasContentContinuity(evidence: QueryWorkEvidence, committed: ArtifactStateEvidence[]): boolean {
  return attributableArtifactStates(evidence).some((observed) =>
    committed.some((candidate) => artifactStatesMatch(observed, candidate))
  );
}

/**
 * Snapshot-only evidence predates execution proof capture and remains valid
 * under its normal baseline rules. Once a record carries an explicit causal
 * proof set, however, it is an authority boundary: an empty set after native
 * revalidation must not silently fall back to broad artifact-state matching.
 */
function attributableArtifactStates(evidence: QueryWorkEvidence): ArtifactStateEvidence[] {
  if (evidence.causalWriteArtifactsComplete !== true) {
    return evidence.artifactStates ?? [];
  }
  const artifactKeys = new Set((evidence.causalWriteArtifacts ?? [])
    .map((artifact) => artifact.artifactKey));
  return (evidence.artifactStates ?? []).filter((state) => artifactKeys.has(state.artifactKey));
}

function artifactStatesMatch(observed: ArtifactStateEvidence, committed: ArtifactStateEvidence): boolean {
  const sameArtifact = observed.artifactKey === committed.artifactKey
    || observed.artifactKey === committed.previousArtifactKey
    || observed.previousArtifactKey === committed.artifactKey;
  if (!sameArtifact) {
    return false;
  }
  if (observed.changeKind === "deleted" && committed.changeKind === "deleted") {
    return true;
  }
  if (!committed.stateKey) {
    return false;
  }
  return committed.stateKey === observed.worktreeStateKey || committed.stateKey === observed.indexStateKey;
}

function proofKindFor(evidence: QueryWorkEvidence[], committed: ArtifactStateEvidence[]): AttributionProof["kind"] {
  const deletion = evidence.some((item) => attributableArtifactStates(item).some((observed) =>
    committed.some((candidate) =>
      observed.changeKind === "deleted"
      && candidate.changeKind === "deleted"
      && observed.artifactKey === candidate.artifactKey
    )
  ));
  return deletion ? "observed_deletion" : "exact_content_state";
}

function matchedArtifactCount(evidence: QueryWorkEvidence[], committed: ArtifactStateEvidence[]): number {
  const matches = new Set<string>();
  for (const item of evidence) {
    for (const observed of attributableArtifactStates(item)) {
      if (committed.some((candidate) => artifactStatesMatch(observed, candidate))) {
        matches.add(observed.artifactKey);
      }
    }
  }
  return matches.size;
}

/**
 * A commit claim may retain only causal source pairs whose own artifact state
 * actually matched this candidate.  Broad query evidence, same-name tools,
 * and causal pairs for another changed artifact are deliberately excluded.
 * Snapshot-only/legacy evidence has no pair authority and therefore produces
 * no revocable proof pointer.
 */
function matchedCausalWriteArtifactsForCommit(
  evidence: QueryWorkEvidence[],
  committed: ArtifactStateEvidence[]
): MatchedCausalWriteArtifactEvidence[] {
  const byPair = new Map<string, MatchedCausalWriteArtifactEvidence>();
  for (const item of evidence) {
    if (item.causalWriteArtifactsComplete !== true) {
      continue;
    }
    for (const pair of item.causalWriteArtifacts ?? []) {
      const matched = (item.artifactStates ?? []).some((observed) =>
        observed.artifactKey === pair.artifactKey
        && committed.some((candidate) => artifactStatesMatch(observed, candidate))
      );
      if (!matched) {
        continue;
      }
      const value: MatchedCausalWriteArtifactEvidence = {
        queryId: item.queryId,
        artifactKey: pair.artifactKey,
        executionNodeId: pair.executionNodeId
      };
      byPair.set(`${value.queryId}:${value.artifactKey}:${value.executionNodeId}`, value);
    }
  }
  return [...byPair.values()].sort((left, right) =>
    left.queryId.localeCompare(right.queryId)
    || left.artifactKey.localeCompare(right.artifactKey)
    || left.executionNodeId.localeCompare(right.executionNodeId)
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
