import {
  AgenticWorkEpisode,
  ArtifactStateEvidence,
  AttributionDecision,
  AttributionProof,
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
  const proofKind = proofKindFor(currentEpochEvidence, candidate.artifactStates);
  return {
    decision: "reportable",
    queryIds,
    proof: {
      kind: proofKind,
      anchorQueryIds: uniqueStrings([...anchors, ...retainedCandidateAnchors]),
      inheritedQueryIds: inherited,
      matchedArtifactCount: matchedArtifactCount(currentEpochEvidence, candidate.artifactStates),
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
  return (evidence.artifactStates ?? []).some((observed) =>
    committed.some((candidate) => artifactStatesMatch(observed, candidate))
  );
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
  const deletion = evidence.some((item) => (item.artifactStates ?? []).some((observed) =>
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
    for (const observed of item.artifactStates ?? []) {
      if (committed.some((candidate) => artifactStatesMatch(observed, candidate))) {
        matches.add(observed.artifactKey);
      }
    }
  }
  return matches.size;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort();
}
