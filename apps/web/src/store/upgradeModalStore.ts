import { create } from "zustand";
import { LimitReason } from "~/lib/constants/plans";

interface UpgradeModalStore {
  isOpen: boolean;
  reason?: LimitReason;
  action: {
    openModal: (modalReason?: LimitReason) => void;
    closeModal: () => void;
  };
}

export const useUpgradeModalStore = create<UpgradeModalStore>((set) => ({
  isOpen: false,
  reason: undefined,
  action: {
    openModal: (modalReason?: LimitReason) =>
      set({ isOpen: true, reason: modalReason }),
    closeModal: () => set({ isOpen: false, reason: undefined }),
  },
}));
