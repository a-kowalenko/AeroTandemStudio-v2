export type TaskProgressState = {
  taskId: number;
  percent: number;
  status: string;
};

export type EncodeProgress = {
  percent: number;
  current_secs: number;
  total_secs: number;
  status: string;
  task_id?: number | null;
};
