import type { SVGProps } from "react";

export {
  ArrowPathIcon, ArrowsPointingInIcon as MergeIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, Cog6ToothIcon, EyeSlashIcon,
  LinkIcon, MagnifyingGlassIcon, PencilIcon, PlayIcon, PlusIcon, QuestionMarkCircleIcon as QuestionIcon, Squares2X2Icon as MosaicIcon,
  StarIcon, UserGroupIcon as PeopleIcon, UserPlusIcon, XMarkIcon,
} from "@heroicons/react/24/outline";

/** A thumbtack for 고정; heroicons has none. Same 1.5 stroke as the outline set. */
export function PinIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M9 3.75h6M10.5 3.75v5.5L7.5 13.5h9l-3-4.25v-5.5M12 13.5v6.75" />
  </svg>;
}
