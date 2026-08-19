const MODEL_LABELS = {
  default: 'Default',
  sol: 'GPT-5.6 Sol',
  luna: 'GPT-5.6 Luna',
};

const REASONING_LABELS = {
  default: 'default reasoning',
  instant: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  'extra-high': 'Extra High',
};

const STATE_LABELS = {
  prepared: 'Prepared',
  submitted: 'Running',
  ready: 'Waiting to apply',
  completed: 'Completed',
  applied: 'Applied',
  'rolled-back': 'Rolled back',
  conflicted: 'Needs conflict resolution',
  resolved: 'Resolved',
  failed: 'Needs attention',
};

const STATUS_TEXT = {
  prepared: ['Package prepared', 'Send this task when you are ready.'],
  submitted: ['Task is running', 'Still generating. The conversation is being watched for the result file.'],
  ready: ['Waiting to apply', 'The plain-text result is validated and waiting for you to apply it.'],
  conflicted: ['Conflict needs resolution', 'Clean up the task target and retry the apply, or send a resolution task to preserve both versions.'],
  resolved: ['Conflict resolved', 'The original task conflict was resolved by a follow-up task.'],
  applied: ['Changes applied', 'The validated patch has been applied to the task target.'],
  'rolled-back': ['Changes reverted', 'The changes from this task were reverted.'],
  failed: ['Task needs attention', 'Stopped before making unsafe or conflicting changes.'],
};

function taskLabel(task) {
  if (task.summaryOnly) {
    const repositoryName = task.repositories?.[0]?.name;
    return repositoryName ? `Git Summary · ${repositoryName}` : 'Git Summary';
  }
  return String(task.conversationTitle || task.taskText || 'Untitled task').split('\n')[0].trim() || 'Untitled task';
}

function taskStateLabel(task) {
  if (task.answerOnly && task.state === 'completed') return 'Answered';
  if (task.summaryOnly) {
    if (task.state === 'completed') return 'Summary applied';
    if (task.state === 'ready') return 'Summary ready';
    if (task.state === 'submitted' && task.chatStatus === 'completed') return 'Response complete';
    if (task.state === 'submitted' && task.chatStatus === 'failed') return 'Generation stopped';
    if (task.state === 'submitted') return 'Generating summary';
    if (task.state === 'prepared') return 'Preparing summary';
  }
  if (task.state === 'submitted' && task.chatStatus === 'completed') return 'Response complete';
  if (task.state === 'submitted' && task.chatStatus === 'failed') return 'Generation stopped';
  return STATE_LABELS[task.state] || task.state;
}

function taskStatusText(task) {
  if (task.answerOnly) {
    if (task.state === 'completed') {
      return ['Answer complete', 'The detailed response is finished in the conversation.'];
    }
    if (task.state === 'submitted' && task.chatStatus === 'failed') {
      return ['Generation stopped', 'Generation failed before the answer was complete.'];
    }
    if (task.state === 'submitted') {
      return ['Answer is running', 'The response is still generating. No result file is expected.'];
    }
    if (task.state === 'prepared') {
      return ['Answer task prepared', 'Send this read-only question when you are ready.'];
    }
  }
  if (task.summaryOnly) {
    if (task.state === 'completed') {
      return ['Git Summary applied', 'The generated Conventional Commit message was moved to the Source Control commit editor.'];
    }
    if (task.state === 'ready') {
      return ['Git Summary ready', 'Review the message below, then use it in Source Control to complete this task.'];
    }
    if (task.state === 'submitted' && task.chatStatus === 'completed') {
      return ['Response complete', 'The summary is finished. The result file is downloading.'];
    }
    if (task.state === 'submitted' && task.chatStatus === 'failed') {
      return ['Git Summary stopped', 'Generation failed for this summary.'];
    }
    if (task.state === 'submitted') {
      return ['Generating Git Summary', 'Monitoring the conversation and result file.'];
    }
    if (task.state === 'prepared') {
      return ['Preparing Git Summary', 'The current working changes are packaged and ready to send.'];
    }
  }
  if (task.state === 'submitted' && task.chatStatus === 'completed') {
    return ['Response complete', 'Generation is finished. Checking for the result file.'];
  }
  if (task.state === 'submitted' && task.chatStatus === 'failed') {
    return ['Generation stopped', 'Generation failed for this task.'];
  }
  return STATUS_TEXT[task.state] || STATUS_TEXT.prepared;
}

function bundledIacCount(task) {
  return Array.isArray(task.iac_repos)
    ? task.iac_repos.filter((repository) => repository.status === 'bundled').length
    : 0;
}

function taskConfigurationLabel(task) {
  const skillCount = Array.isArray(task.skills) ? task.skills.length : 0;
  const skills = skillCount ? ` · ${skillCount} skill${skillCount === 1 ? '' : 's'}` : '';
  const iacCount = bundledIacCount(task);
  const iac = iacCount ? ` · ${iacCount} IaC` : '';
  const model = MODEL_LABELS[task.model || 'default'] || task.model;
  const reasoning = REASONING_LABELS[task.reasoningMode || 'default'] || task.reasoningMode;
  const mode = task.answerOnly ? ' · answer only' : '';
  return `${model} · ${reasoning}${mode}${skills}${iac}`;
}

function treeStateLabel(tree) {
  if (!tree.available) return tree.error || 'Unavailable';
  if (tree.mergeState === 'submitted') return 'Merging in chat';
  if (tree.mergeState === 'failed') return 'Merge failed';
  if (!tree.clean) return 'Has uncommitted changes';
  return `${tree.commitCount || 0} commit${tree.commitCount === 1 ? '' : 's'}`;
}

module.exports = {
  MODEL_LABELS,
  REASONING_LABELS,
  STATE_LABELS,
  STATUS_TEXT,
  bundledIacCount,
  taskConfigurationLabel,
  taskLabel,
  taskStateLabel,
  taskStatusText,
  treeStateLabel,
};
