export type CreateModalReadiness = Readonly<{
  busy: boolean;
  loading: boolean;
  detailLoading: boolean;
  protectedDraftOrCommand: boolean;
  online: boolean;
  visible: boolean;
  memberAvailable: boolean;
  bindingAvailable: boolean;
  forgotten: boolean;
}>;

/** Rendered create controls mirror the editor guards; openModal still rechecks live protection. */
export function isCreateModalReady(state: CreateModalReadiness): boolean {
  return (
    state.online &&
    state.visible &&
    state.memberAvailable &&
    state.bindingAvailable &&
    !state.forgotten &&
    !state.busy &&
    !state.loading &&
    !state.detailLoading &&
    !state.protectedDraftOrCommand
  );
}
