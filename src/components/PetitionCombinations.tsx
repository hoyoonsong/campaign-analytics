import { PetitionOverlapBars } from './PetitionOverlapBars';
import { PetitionVenn } from './PetitionVenn';
import {
  collapseCombosToUnits,
  unitsAsVirtualPetitions,
  type Petition,
  type PetitionUnit,
} from '../lib/petitions';
import type { PetitionComboCount } from '../lib/types';

type Props = {
  units: PetitionUnit[];
  combos?: PetitionComboCount[] | null;
  onSelectUnitCombo?: (unitMask: number) => void;
  onSelectPetitionExclusive?: (petition: Petition) => void;
  onSelectSuperSigners?: () => void;
  compact?: boolean;
};

export function PetitionCombinations({
  units,
  combos,
  onSelectUnitCombo,
  onSelectPetitionExclusive,
  onSelectSuperSigners,
  compact = false,
}: Props) {
  if (units.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        Select at least one petition to see combinations.
      </p>
    );
  }
  if (units.length <= 3) {
    const virtual = unitsAsVirtualPetitions(units);
    const collapsed = collapseCombosToUnits(combos, units);
    return (
      <PetitionVenn
        compact={compact}
        petitions={virtual}
        combos={collapsed}
        onSelectCombo={onSelectUnitCombo}
      />
    );
  }
  return (
    <PetitionOverlapBars
      units={units}
      combos={combos}
      onSelectUnitCombo={onSelectUnitCombo}
      onSelectPetitionExclusive={onSelectPetitionExclusive}
      onSelectSuperSigners={onSelectSuperSigners}
    />
  );
}
