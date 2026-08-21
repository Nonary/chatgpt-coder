function createTaskInput(composer, chatgptProject = null) {
  const input = {
    taskText: composer.taskText,
    repositories: composer.repositories.map((repository) => ({ path: repository.path })),
    attachments: composer.attachments.map((attachment) => ({ path: attachment.path })),
    skillIds: composer.skillIds,
    promptIds: composer.promptIds,
    model: composer.model,
    reasoningMode: composer.reasoningMode,
    includeIac: composer.includeIac,
    answerOnly: composer.mode === 'ask',
    chatgptProject,
  };

  if (composer.treeSelection === '__new__') {
    input.createTree = true;
    input.treeName = composer.treeName;
  } else if (composer.treeSelection) {
    input.treeId = composer.treeSelection;
  }

  return input;
}

module.exports = { createTaskInput };
