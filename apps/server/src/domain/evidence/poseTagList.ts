/**
 * 姿势相关的一般标签（按姿势找图用，186 个）：PoseWear 匹配规则里用到的标签，加上一批常见的姿势标签。
 * 来自原型 F:/Claude/.work/pose-proto/out/posewear_v2/retag_low.py 的 pose_tags()（按名字排好序）。
 * 识别时这些标签分数在 [POSE_LOW_MIN, 一般标签阈值) 的记进 image_pose_tags_low（domain/evidence/poseTags.ts）。
 * 改了名单就加 POSE_TAGS_VERSION（以后要按版本补跑时用）。
 */
export const POSE_TAGS_VERSION = 1;

/** 低分的下限：原型的 LOW_MIN */
export const POSE_LOW_MIN = 0.17;

export const POSE_TAGS: readonly string[] = [
  'adjusting_hair', 'against_glass', 'against_wall', 'all_fours', 'arched_back', 'arm_around_waist', 'arm_behind_back', 'arm_behind_head',
  'arm_rest', 'arm_support', 'arm_under_breasts', 'arm_up', 'armpits', 'arms_behind_back', 'arms_behind_head', 'arms_under_breasts',
  'arms_up', 'ass', 'ass_focus', 'ass_grab', 'bed', 'bed_sheet', 'bent_over', 'between_breasts', 'between_legs', 'blowing_kiss', 'bra',
  'bra_removed', 'breast_hold', 'breast_lift', 'breast_press', 'breast_rest', 'breasts_on_table', 'breasts_out',
  'breasts_squeezed_together', 'bridge', 'claw_pose', 'cleavage', 'clenched_hand', 'clenched_hands', 'contrapposto', 'covering_breasts',
  'covering_nipples', 'covering_one_eye', 'covering_own_eyes', 'covering_own_mouth', 'crossed_arms', 'crossed_legs', 'double_v', 'feet_up',
  'fighting_stance', 'finger_frame', 'finger_heart', 'finger_in_mouth', 'finger_in_own_mouth', 'finger_sucking', 'finger_to_cheek',
  'finger_to_mouth', 'floating_hair', 'folded', 'from_above', 'from_behind', 'from_side', 'grabbing_own_breast', 'gyaru_v',
  'hair_behind_ear', 'hair_lift', 'hair_tucking', 'hand_between_breasts', 'hand_between_legs', 'hand_in_own_cleavage', 'hand_in_own_hair',
  'hand_on_own_cheek', 'hand_on_own_chest', 'hand_on_own_chin', 'hand_on_own_face', 'hand_on_own_head', 'hand_on_own_hip',
  'hand_on_own_knee', 'hand_on_own_neck', 'hand_on_own_stomach', 'hand_on_own_thigh', 'hand_on_wall', 'hand_over_eye',
  'hand_over_own_mouth', 'hand_to_own_mouth', 'hand_up', 'hands_between_legs', 'hands_in_own_hair', 'hands_on_feet', 'hands_on_ground',
  'hands_on_lap', 'hands_on_own_cheeks', 'hands_on_own_chest', 'hands_on_own_chin', 'hands_on_own_face', 'hands_on_own_hips',
  'hands_on_own_knees', 'hands_on_own_thighs', 'hands_up', 'hanging_breasts', 'head_back', 'head_rest', 'head_tilt', 'heart_arms',
  'heart_hands', 'holding_own_foot', 'holding_own_hair', 'holding_own_leg', 'hugging_own_legs', 'indian_style', 'knee_up', 'kneeling',
  'knees_apart_feet_together', 'knees_to_chest', 'knees_together_feet_apart', 'knees_up', 'leaning_back', 'leaning_forward',
  'leaning_to_the_side', 'leg_grab', 'leg_hold', 'leg_lift', 'leg_up', 'legs_apart', 'legs_up', 'licking_finger', 'looking_at_viewer',
  'looking_back', 'looking_up', 'lying', 'm_legs', 'nude', 'off_shoulder', 'on_back', 'on_bed', 'on_one_knee', 'on_side', 'on_stomach',
  'one_eye_closed', 'outstretched_arm', 'outstretched_arms', 'own_hands_clasped', 'own_hands_together', 'paw_pose',
  'peeking_through_fingers', 'pillow_hug', 'pointing_at_viewer', 'praying', 'presenting_armpit', 'rabbit_pose', 'reaching_towards_viewer',
  'reclining', 'salute', 'seiza', 'self_hug', 'showering', 'shushing', 'sitting', 'split', 'spread_arms', 'spread_legs', 'squatting',
  'standing', 'standing_on_one_leg', 'standing_split', 'straddling', 'strap_pull', 'strap_slip', 'stretching', 'tiptoes',
  'top-down_bottom-up', 'topless', 'tucking_hair', 'twisted_torso', 'undressing', 'unhooking_bra', 'upside-down', 'v', 'v_arms', 'w',
  'wariza', 'wet', 'wind', 'yawning', 'yokozuwari',
];
