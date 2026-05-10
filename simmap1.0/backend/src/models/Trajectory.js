import { DataTypes } from 'sequelize'

export function defineTrajectoryModel(sequelize) {
  return sequelize.define('Trajectory', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    vehicleId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '车辆ID'
    },
    latitude: {
      type: DataTypes.FLOAT,
      allowNull: false,
      comment: '纬度'
    },
    longitude: {
      type: DataTypes.FLOAT,
      allowNull: false,
      comment: '经度'
    },
    speed: {
      type: DataTypes.FLOAT,
      comment: '速度 (km/h)'
    },
    heading: {
      type: DataTypes.FLOAT,
      comment: '方向 (度)'
    },
    timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: '记录时间'
    }
  })
}
