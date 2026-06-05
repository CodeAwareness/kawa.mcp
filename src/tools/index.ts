import { checkActiveIntentTool, checkActiveIntent, checkActiveIntentSchema } from './check-active-intent.js'
import { getRelevantContextTool, getRelevantContext, getRelevantContextSchema } from './get-relevant-context.js'
import { createAndActivateIntentTool, createAndActivateIntent, createAndActivateIntentSchema } from './create-intent.js'
import { activateIntentTool, activateIntent, activateIntentSchema } from './activate-intent.js'
import { getIntentsForFileTool, getIntentsForFile, getIntentsForFileSchema } from './get-intents-for-file.js'
import { getIntentsForLinesTool, getIntentsForLines, getIntentsForLinesSchema } from './get-intents-for-lines.js'
import { listTeamIntentsTool, listTeamIntents, listTeamIntentsSchema } from './list-team-intents.js'
import { getIntentChangesTool, getIntentChanges, getIntentChangesSchema } from './get-intent-changes.js'
import { completeIntentTool, completeIntent, completeIntentSchema } from './complete-intent.js'
import { updateIntentTool, updateIntent, updateIntentSchema } from './update-intent.js'
import { logWorkTool, logWork, logWorkSchema } from './log-work.js'
import { recordDecisionTool, recordDecision, recordDecisionSchema } from './record-decision.js'
import { getSessionDecisionsTool, getSessionDecisions, getSessionDecisionsSchema } from './get-session-decisions.js'
import { getProjectDecisionsTool, getProjectDecisions, getProjectDecisionsSchema } from './get-project-decisions.js'
import { getDecisionDetailTool, getDecisionDetail, getDecisionDetailSchema } from './get-decision-detail.js'
import { editSessionDecisionTool, editSessionDecision, editSessionDecisionSchema } from './edit-session-decision.js'
import { detectIntentConflictsTool, detectIntentConflicts, detectIntentConflictsSchema } from './detect-intent-conflicts.js'
import { inferHistoryTool, inferHistory, inferHistorySchema } from './infer-history.js'
import { evolveDecisionsTool, evolveDecisions, evolveDecisionsSchema } from './evolve-decisions.js'
import { updateFeaturesTool, updateFeatures, updateFeaturesSchema } from './update-features.js'
import { preEditDecisionCheckTool, preEditDecisionCheck, preEditDecisionCheckSchema } from './pre-edit-decision-check.js'
import { preEditAcknowledgeTool, preEditAcknowledge, preEditAcknowledgeSchema } from './pre-edit-acknowledge.js'

// Re-export everything
export {
  // Relevance-based context (call per request)
  getRelevantContextTool,
  getRelevantContext,
  getRelevantContextSchema,
  // Intent tools
  checkActiveIntentTool,
  checkActiveIntent,
  checkActiveIntentSchema,
  createAndActivateIntentTool,
  createAndActivateIntent,
  createAndActivateIntentSchema,
  activateIntentTool,
  activateIntent,
  activateIntentSchema,
  getIntentsForFileTool,
  getIntentsForFile,
  getIntentsForFileSchema,
  getIntentsForLinesTool,
  getIntentsForLines,
  getIntentsForLinesSchema,
  listTeamIntentsTool,
  listTeamIntents,
  listTeamIntentsSchema,
  getIntentChangesTool,
  getIntentChanges,
  getIntentChangesSchema,
  completeIntentTool,
  completeIntent,
  completeIntentSchema,
  updateIntentTool,
  updateIntent,
  updateIntentSchema,
  // Lightweight logging
  logWorkTool,
  logWork,
  logWorkSchema,
  // Decision recording tools
  recordDecisionTool,
  recordDecision,
  recordDecisionSchema,
  getSessionDecisionsTool,
  getSessionDecisions,
  getSessionDecisionsSchema,
  getProjectDecisionsTool,
  getProjectDecisions,
  getProjectDecisionsSchema,
  getDecisionDetailTool,
  getDecisionDetail,
  getDecisionDetailSchema,
  editSessionDecisionTool,
  editSessionDecision,
  editSessionDecisionSchema,
  // Conflict detection
  detectIntentConflictsTool,
  detectIntentConflicts,
  detectIntentConflictsSchema,
  // Inference pipeline tools
  inferHistoryTool,
  inferHistory,
  inferHistorySchema,
  evolveDecisionsTool,
  evolveDecisions,
  evolveDecisionsSchema,
  // Feature catalog
  updateFeaturesTool,
  updateFeatures,
  updateFeaturesSchema,
  // Pre-edit decision check
  preEditDecisionCheckTool,
  preEditDecisionCheck,
  preEditDecisionCheckSchema,
  preEditAcknowledgeTool,
  preEditAcknowledge,
  preEditAcknowledgeSchema
}

export const allTools = [
  // Relevance-based context - CALL PER REQUEST
  getRelevantContextTool,
  // Intent tools
  checkActiveIntentTool,
  createAndActivateIntentTool,
  activateIntentTool,
  getIntentsForFileTool,
  getIntentsForLinesTool,
  listTeamIntentsTool,
  getIntentChangesTool,
  completeIntentTool,
  updateIntentTool,
  // Lightweight logging
  logWorkTool,
  // Decision recording tools
  recordDecisionTool,
  getSessionDecisionsTool,
  getProjectDecisionsTool,
  getDecisionDetailTool,
  editSessionDecisionTool,
  // Conflict detection
  detectIntentConflictsTool,
  // Inference pipeline tools
  inferHistoryTool,
  evolveDecisionsTool,
  // Feature catalog
  updateFeaturesTool,
  // Pre-edit decision check
  preEditDecisionCheckTool,
  preEditAcknowledgeTool
]
